use std::{
    collections::HashSet, error::Error, fmt, future::Future, io, pin::Pin, sync::Arc,
    time::Duration,
};

use tokio::{sync::Mutex, time::Instant};

use crate::transport::pool::Connector;

const SNAPSHOT_TTL: Duration = Duration::from_secs(4);

pub type RunningFuture<'a> = Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + 'a>>;

pub trait RunningQuery: Send + Sync {
    fn running(&self) -> RunningFuture<'_>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotRunning(String),
    Unknown(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRunning(distro) => {
                write!(formatter, "WSL distribution {distro} is not running.")
            }
            Self::Unknown(distro) => write!(
                formatter,
                "Choux could not check whether WSL distribution {distro} is running."
            ),
        }
    }
}

impl Error for Refusal {}

impl From<Refusal> for String {
    fn from(refusal: Refusal) -> Self {
        refusal.to_string()
    }
}

pub fn refusal(error: &io::Error) -> Option<&Refusal> {
    error.get_ref()?.downcast_ref()
}

type Snapshot = (Instant, Option<HashSet<String>>);

pub struct DistroGate<Q> {
    query: Q,
    snapshot: Mutex<Option<Snapshot>>,
}

impl<Q: Default + RunningQuery> Default for DistroGate<Q> {
    fn default() -> Self {
        Self::new(Q::default())
    }
}

impl<Q: RunningQuery> DistroGate<Q> {
    pub fn new(query: Q) -> Self {
        Self {
            query,
            snapshot: Mutex::new(None),
        }
    }

    pub async fn check(&self, distro: &str) -> Result<(), Refusal> {
        self.check_asked_since(distro, None).await
    }

    pub async fn check_fresh(&self, distro: &str) -> Result<(), Refusal> {
        let needed_since = Instant::now();
        self.check_asked_since(distro, Some(needed_since)).await
    }

    pub async fn forget(&self) {
        *self.snapshot.lock().await = None;
    }

    async fn check_asked_since(&self, distro: &str, since: Option<Instant>) -> Result<(), Refusal> {
        let mut snapshot = self.snapshot.lock().await;
        let usable = snapshot.as_ref().filter(|(asked, _)| {
            asked.elapsed() < SNAPSHOT_TTL && since.map_or(true, |since| *asked >= since)
        });
        let running = match usable {
            Some((_, running)) => running.clone(),
            None => {
                let asked = Instant::now();
                let running = self
                    .query
                    .running()
                    .await
                    .map(|names| names.into_iter().collect::<HashSet<_>>());
                *snapshot = Some((asked, running.clone()));
                running
            }
        };
        match running {
            None => Err(Refusal::Unknown(distro.into())),
            Some(names) if names.contains(distro) => Ok(()),
            Some(_) => Err(Refusal::NotRunning(distro.into())),
        }
    }
}

pub type Guard<Q> = (String, Arc<DistroGate<Q>>);

pub struct GatedConnector<C, Q> {
    inner: C,
    guard: Option<Guard<Q>>,
}

impl<C, Q> GatedConnector<C, Q> {
    pub fn new(inner: C, guard: Option<Guard<Q>>) -> Self {
        Self { inner, guard }
    }
}

impl<C: Connector, Q: RunningQuery> Connector for GatedConnector<C, Q> {
    type Link = C::Link;

    async fn open(&self) -> io::Result<C::Link> {
        if let Some((distro, gate)) = &self.guard {
            gate.check_fresh(distro).await.map_err(io::Error::other)?;
        }
        self.inner.open().await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex as StdMutex,
    };

    use tokio::io::DuplexStream;

    use super::*;
    use crate::transport::pool::{Link, LinkFailure};

    const QUERY_TIME: Duration = Duration::from_millis(100);

    #[derive(Clone, Default)]
    struct FakeQuery {
        answer: Arc<StdMutex<Option<Vec<String>>>>,
        calls: Arc<AtomicUsize>,
    }

    impl FakeQuery {
        fn answering(names: Option<&[&str]>) -> Self {
            let query = Self::default();
            query.set(names);
            query
        }

        fn set(&self, names: Option<&[&str]>) {
            *self.answer.lock().unwrap() =
                names.map(|names| names.iter().map(|name| name.to_string()).collect());
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl RunningQuery for FakeQuery {
        fn running(&self) -> RunningFuture<'_> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                let sampled = self.answer.lock().unwrap().clone();
                tokio::time::sleep(QUERY_TIME).await;
                sampled
            })
        }
    }

    impl Link for DuplexStream {
        fn has_ended(&mut self) -> bool {
            false
        }

        async fn diagnose(self) -> Option<LinkFailure> {
            None
        }
    }

    #[derive(Default)]
    struct CountingConnector(AtomicUsize);

    impl Connector for CountingConnector {
        type Link = DuplexStream;

        fn open(&self) -> impl Future<Output = io::Result<DuplexStream>> + Send {
            self.0.fetch_add(1, Ordering::SeqCst);
            async { Ok(tokio::io::duplex(64).0) }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_a_stopped_distribution_and_admits_a_running_one() {
        let query = FakeQuery::answering(Some(&["Debian"]));
        let gate = DistroGate::new(query.clone());

        assert_eq!(gate.check("Debian").await, Ok(()));
        assert_eq!(
            gate.check("Ubuntu").await,
            Err(Refusal::NotRunning("Ubuntu".into()))
        );
        assert_eq!(query.calls(), 1);
    }

    #[test]
    fn explains_each_refusal() {
        assert_eq!(
            Refusal::NotRunning("Debian".into()).to_string(),
            "WSL distribution Debian is not running."
        );
        assert_eq!(
            Refusal::Unknown("Debian".into()).to_string(),
            "Choux could not check whether WSL distribution Debian is running."
        );
    }

    #[tokio::test(start_paused = true)]
    async fn asks_again_once_the_snapshot_is_old() {
        let query = FakeQuery::answering(Some(&[]));
        let gate = DistroGate::new(query.clone());
        assert!(gate.check("Debian").await.is_err());

        query.set(Some(&["Debian"]));
        tokio::time::advance(SNAPSHOT_TTL - QUERY_TIME - Duration::from_millis(1)).await;
        assert!(gate.check("Debian").await.is_err());
        tokio::time::advance(Duration::from_millis(1)).await;

        assert_eq!(gate.check("Debian").await, Ok(()));
        assert_eq!(query.calls(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_fresh_check_ignores_a_snapshot_taken_before_it() {
        let query = FakeQuery::answering(Some(&["Debian"]));
        let gate = DistroGate::new(query.clone());
        assert_eq!(gate.check("Debian").await, Ok(()));

        query.set(Some(&[]));
        tokio::time::advance(Duration::from_millis(1)).await;

        assert!(gate.check_fresh("Debian").await.is_err());
        assert_eq!(query.calls(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_fresh_check_rejects_an_answer_sampled_before_it_began() {
        let query = FakeQuery::answering(Some(&["Debian"]));
        let gate = Arc::new(DistroGate::new(query.clone()));
        let sampled_while_running = tokio::spawn({
            let gate = Arc::clone(&gate);
            async move { gate.check("Debian").await }
        });
        tokio::time::sleep(QUERY_TIME / 2).await;
        query.set(Some(&[]));

        let fresh = gate.check_fresh("Debian").await;

        assert_eq!(sampled_while_running.await.unwrap(), Ok(()));
        assert_eq!(fresh, Err(Refusal::NotRunning("Debian".into())));
        assert_eq!(query.calls(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn forgetting_the_snapshot_asks_again_on_the_next_check() {
        let query = FakeQuery::answering(Some(&[]));
        let gate = DistroGate::new(query.clone());
        assert!(gate.check("Debian").await.is_err());

        query.set(Some(&["Debian"]));
        gate.forget().await;

        assert_eq!(gate.check("Debian").await, Ok(()));
        assert_eq!(query.calls(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn fresh_checks_at_the_same_moment_share_one_query() {
        let query = FakeQuery::answering(Some(&["Debian"]));
        let gate = Arc::new(DistroGate::new(query.clone()));
        assert_eq!(gate.check("Debian").await, Ok(()));
        query.set(Some(&[]));
        tokio::time::advance(Duration::from_millis(1)).await;

        let checks: Vec<_> = (0..3)
            .map(|_| {
                let gate = Arc::clone(&gate);
                tokio::spawn(async move { gate.check_fresh("Debian").await })
            })
            .collect();
        for check in checks {
            assert!(check.await.unwrap().is_err());
        }

        assert_eq!(query.calls(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_connections_when_wsl_cannot_be_asked() {
        let query = FakeQuery::answering(None);
        let gate = DistroGate::new(query.clone());

        assert_eq!(
            gate.check("Debian").await,
            Err(Refusal::Unknown("Debian".into()))
        );
        assert_eq!(
            gate.check("Ubuntu").await,
            Err(Refusal::Unknown("Ubuntu".into()))
        );
        assert_eq!(query.calls(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_checks_share_one_query() {
        let query = FakeQuery::answering(Some(&["Debian"]));
        let gate = Arc::new(DistroGate::new(query.clone()));

        let checks: Vec<_> = (0..3)
            .map(|_| {
                let gate = Arc::clone(&gate);
                tokio::spawn(async move { gate.check("Debian").await })
            })
            .collect();
        for check in checks {
            assert_eq!(check.await.unwrap(), Ok(()));
        }

        assert_eq!(query.calls(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_gated_connector_asks_before_every_spawn_and_never_opens_into_a_stopped_distribution()
    {
        let query = FakeQuery::answering(Some(&["Debian"]));
        let gate = Arc::new(DistroGate::new(query.clone()));
        assert_eq!(gate.check("Debian").await, Ok(()));
        let connector = GatedConnector::new(
            CountingConnector::default(),
            Some(("Debian".to_string(), Arc::clone(&gate))),
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(connector.open().await.is_ok());

        query.set(Some(&[]));
        tokio::time::advance(Duration::from_millis(1)).await;
        let refused = connector.open().await.err().unwrap();

        assert_eq!(
            refusal(&refused),
            Some(&Refusal::NotRunning("Debian".into()))
        );
        assert_eq!(connector.inner.0.load(Ordering::SeqCst), 1);
        assert_eq!(query.calls(), 3);
    }

    #[tokio::test]
    async fn an_ungated_connector_opens_without_asking() {
        let connector = GatedConnector::<_, FakeQuery>::new(CountingConnector::default(), None);

        assert!(connector.open().await.is_ok());
        assert_eq!(connector.inner.0.load(Ordering::SeqCst), 1);
    }
}
