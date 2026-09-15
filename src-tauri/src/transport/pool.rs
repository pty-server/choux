use std::{
    fmt,
    future::Future,
    io,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex as StdMutex, PoisonError,
    },
    time::Duration,
};

use serde::Deserialize;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{Mutex, Notify},
    time::Instant,
};

use super::{
    http::{request_head, HttpConnection, HttpError, Request},
    response::Response,
};

const REUSE_IDLE_LIMIT: Duration = Duration::from_secs(5);
const QUEUE_LIMIT: usize = 16;
const UNAVAILABLE_BACKOFF: Duration = Duration::from_secs(2);

pub trait Link: AsyncRead + AsyncWrite + Unpin + Send + 'static {
    fn has_ended(&mut self) -> bool;
    fn diagnose(self) -> impl Future<Output = Option<LinkFailure>> + Send;
}

pub trait Connector: Send + Sync {
    type Link: Link;
    fn open(&self) -> impl Future<Output = io::Result<Self::Link>> + Send;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkFailure {
    pub message: String,
    pub permanent: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    Shared,
    Dedicated,
}

#[derive(Debug)]
pub enum PoolError {
    Busy,
    Closed,
    TimedOut(Duration),
    Connect(io::Error),
    Unavailable(LinkFailure),
    OutcomeUnknown(String),
    Http {
        error: HttpError,
        diagnosis: Option<LinkFailure>,
    },
}

impl fmt::Display for PoolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => formatter.write_str("too many requests are waiting for this server"),
            Self::Closed => formatter.write_str("the connection was closed"),
            Self::TimedOut(deadline) => write!(
                formatter,
                "the server did not respond within {}s",
                deadline.as_secs()
            ),
            Self::Connect(error) => write!(formatter, "could not open a connection: {error}"),
            Self::Unavailable(failure) => formatter.write_str(&failure.message),
            Self::OutcomeUnknown(cause) => write!(
                formatter,
                "the request may or may not have been applied: {cause}"
            ),
            Self::Http { error, diagnosis } => match diagnosis {
                Some(failure) => write!(formatter, "{error} ({})", failure.message),
                None => write!(formatter, "{error}"),
            },
        }
    }
}

struct Shared<L> {
    connection: Option<HttpConnection<L>>,
    idle_since: Instant,
}

pub struct HttpPool<C: Connector> {
    connector: C,
    shared: Mutex<Shared<C::Link>>,
    unavailable: StdMutex<Option<(Instant, LinkFailure)>>,
    waiting: AtomicUsize,
    opened: AtomicUsize,
    deadline: Duration,
    closed: AtomicBool,
    closing: Notify,
}

impl<C: Connector> HttpPool<C> {
    pub fn new(connector: C, deadline: Duration) -> Self {
        Self {
            connector,
            shared: Mutex::new(Shared {
                connection: None,
                idle_since: Instant::now(),
            }),
            unavailable: StdMutex::new(None),
            waiting: AtomicUsize::new(0),
            opened: AtomicUsize::new(0),
            deadline,
            closed: AtomicBool::new(false),
            closing: Notify::new(),
        }
    }

    #[cfg(test)]
    pub fn connections_opened(&self) -> usize {
        self.opened.load(Ordering::Relaxed)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.closing.notify_waiters();
    }

    #[cfg(test)]
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn check_open(&self) -> Result<(), PoolError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(PoolError::Closed)
        } else {
            Ok(())
        }
    }

    pub async fn request(&self, request: &Request<'_>, lane: Lane) -> Result<Response, PoolError> {
        request_head(request).map_err(|error| PoolError::Http {
            error,
            diagnosis: None,
        })?;
        let closing = self.closing.notified();
        self.check_open()?;
        let _slot = match lane {
            Lane::Shared => Some(QueueSlot::take(&self.waiting)?),
            Lane::Dedicated => None,
        };
        let sent = AtomicBool::new(false);
        let exchange = async {
            match lane {
                Lane::Shared => {
                    let request = Request {
                        keep_alive: true,
                        ..*request
                    };
                    self.shared_exchange(request, &sent).await
                }
                Lane::Dedicated => {
                    let request = Request {
                        keep_alive: false,
                        ..*request
                    };
                    self.dedicated_exchange(request, &sent).await
                }
            }
        };
        let may_have_applied = || sent.load(Ordering::SeqCst) && !is_idempotent(request.method);
        tokio::select! {
            biased;
            () = closing => Err(if may_have_applied() {
                PoolError::OutcomeUnknown(PoolError::Closed.to_string())
            } else {
                PoolError::Closed
            }),
            finished = tokio::time::timeout(self.deadline, exchange) => match finished {
                Ok(result) => result,
                Err(_) if may_have_applied() => Err(PoolError::OutcomeUnknown(
                    PoolError::TimedOut(self.deadline).to_string(),
                )),
                Err(_) => Err(PoolError::TimedOut(self.deadline)),
            },
        }
    }

    async fn shared_exchange(
        &self,
        request: Request<'_>,
        sent: &AtomicBool,
    ) -> Result<Response, PoolError> {
        let mut shared = self.shared.lock().await;
        self.check_open()?;
        self.check_available()?;
        if let Some(mut connection) = shared.take_reusable() {
            match send_tracked(&mut connection, &request, sent).await {
                Ok(response) => return Ok(shared.keep(connection, response)),
                Err(error) if retry_on_fresh_connection(&error, request.method) => {}
                Err(error) => return Err(self.fail(connection, error, request.method).await),
            }
        }
        let mut connection = HttpConnection::new(self.open().await?);
        match send_tracked(&mut connection, &request, sent).await {
            Ok(response) => Ok(shared.keep(connection, response)),
            Err(error) => Err(self.fail(connection, error, request.method).await),
        }
    }

    async fn dedicated_exchange(
        &self,
        request: Request<'_>,
        sent: &AtomicBool,
    ) -> Result<Response, PoolError> {
        self.check_open()?;
        self.check_available()?;
        let mut connection = HttpConnection::new(self.open().await?);
        match send_tracked(&mut connection, &request, sent).await {
            Ok(response) => Ok(response),
            Err(error) => Err(self.fail(connection, error, request.method).await),
        }
    }

    async fn open(&self) -> Result<C::Link, PoolError> {
        self.opened.fetch_add(1, Ordering::Relaxed);
        self.connector.open().await.map_err(PoolError::Connect)
    }

    fn check_available(&self) -> Result<(), PoolError> {
        let mut unavailable = self
            .unavailable
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some((until, failure)) = unavailable.as_ref() {
            if Instant::now() < *until {
                return Err(PoolError::Unavailable(failure.clone()));
            }
        }
        *unavailable = None;
        Ok(())
    }

    async fn fail(
        &self,
        connection: HttpConnection<C::Link>,
        error: HttpError,
        method: &str,
    ) -> PoolError {
        let failure = diagnose_failure(connection, error, method).await;
        if let PoolError::Unavailable(link_failure) = &failure {
            *self
                .unavailable
                .lock()
                .unwrap_or_else(PoisonError::into_inner) =
                Some((Instant::now() + UNAVAILABLE_BACKOFF, link_failure.clone()));
        }
        failure
    }
}

impl<L: Link> Shared<L> {
    fn take_reusable(&mut self) -> Option<HttpConnection<L>> {
        let mut connection = self.connection.take()?;
        (self.idle_since.elapsed() < REUSE_IDLE_LIMIT && !connection.stream_mut().has_ended())
            .then_some(connection)
    }

    fn keep(&mut self, connection: HttpConnection<L>, response: Response) -> Response {
        if connection.is_reusable() {
            self.connection = Some(connection);
            self.idle_since = Instant::now();
        }
        response
    }
}

async fn send_tracked<L: Link>(
    connection: &mut HttpConnection<L>,
    request: &Request<'_>,
    sent: &AtomicBool,
) -> Result<Response, HttpError> {
    sent.store(true, Ordering::SeqCst);
    let result = connection.send(request).await;
    if matches!(result, Err(HttpError::NotSent(_))) {
        sent.store(false, Ordering::SeqCst);
    }
    result
}

fn retry_on_fresh_connection(error: &HttpError, method: &str) -> bool {
    match error {
        HttpError::NotSent(_) => true,
        HttpError::Write(_) | HttpError::ClosedBeforeResponse => is_idempotent(method),
        _ => false,
    }
}

fn is_idempotent(method: &str) -> bool {
    method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD")
}

async fn diagnose_failure<L: Link>(
    connection: HttpConnection<L>,
    error: HttpError,
    method: &str,
) -> PoolError {
    let diagnosis = connection.into_stream().diagnose().await;
    if let Some(failure) = diagnosis.as_ref().filter(|failure| failure.permanent) {
        return PoolError::Unavailable(failure.clone());
    }
    let may_have_reached_server = !matches!(error, HttpError::NotSent(_));
    let failure = PoolError::Http { error, diagnosis };
    if may_have_reached_server && !is_idempotent(method) {
        return PoolError::OutcomeUnknown(failure.to_string());
    }
    failure
}

struct QueueSlot<'a>(&'a AtomicUsize);

impl<'a> QueueSlot<'a> {
    fn take(waiting: &'a AtomicUsize) -> Result<Self, PoolError> {
        if waiting.fetch_add(1, Ordering::SeqCst) >= QUEUE_LIMIT {
            waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(PoolError::Busy);
        }
        Ok(Self(waiting))
    }
}

impl Drop for QueueSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::{HashMap, VecDeque},
        pin::Pin,
        sync::Arc,
        task::{Context, Poll},
    };
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt, DuplexStream, ReadBuf};

    struct FakeLink {
        stream: DuplexStream,
        failure: Option<LinkFailure>,
    }

    impl Link for FakeLink {
        fn has_ended(&mut self) -> bool {
            false
        }

        async fn diagnose(self) -> Option<LinkFailure> {
            self.failure
        }
    }

    impl AsyncRead for FakeLink {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.stream).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for FakeLink {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.stream).poll_write(cx, buf)
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.stream).poll_flush(cx)
        }

        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.stream).poll_shutdown(cx)
        }
    }

    #[derive(Default)]
    struct FakeConnector {
        links: StdMutex<VecDeque<FakeLink>>,
    }

    impl FakeConnector {
        fn link(&self) -> DuplexStream {
            self.link_with(4096, None)
        }

        fn link_with(&self, capacity: usize, failure: Option<LinkFailure>) -> DuplexStream {
            let (client, server) = duplex(capacity);
            self.links.lock().unwrap().push_back(FakeLink {
                stream: client,
                failure,
            });
            server
        }
    }

    impl Connector for FakeConnector {
        type Link = FakeLink;

        fn open(&self) -> impl Future<Output = io::Result<FakeLink>> + Send {
            let link = self
                .links
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| io::Error::other("no link was prepared"));
            async move { link }
        }
    }

    fn pool(deadline: Duration) -> HttpPool<FakeConnector> {
        HttpPool::new(FakeConnector::default(), deadline)
    }

    fn request<'a>(method: &'a str, headers: &'a HashMap<String, String>) -> Request<'a> {
        Request {
            method,
            path: "/v1/info",
            host: "ptys.local",
            headers,
            body: None,
            keep_alive: false,
        }
    }

    async fn read_head(server: &mut DuplexStream) -> String {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(server.read_u8().await.unwrap());
        }
        String::from_utf8(head).unwrap()
    }

    async fn answer(server: &mut DuplexStream, body: &str) -> String {
        let head = read_head(server).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        server.write_all(response.as_bytes()).await.unwrap();
        head
    }

    fn outcome_unknown_because(response: &Result<Response, PoolError>, cause: &str) -> bool {
        matches!(response, Err(PoolError::OutcomeUnknown(text)) if text.contains(cause))
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_one_connection_alive_across_requests() {
        let pool = pool(Duration::from_secs(15));
        let mut server = pool.connector.link();
        let headers = HashMap::new();
        let get = request("GET", &headers);

        for body in ["one", "two"] {
            let (response, head) =
                tokio::join!(pool.request(&get, Lane::Shared), answer(&mut server, body));
            assert_eq!(response.unwrap().body, body.as_bytes());
            assert!(!head.contains("Connection: close"), "{head}");
        }
        assert_eq!(pool.connections_opened(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn replaces_a_connection_idle_past_the_reuse_limit() {
        let pool = pool(Duration::from_secs(15));
        let mut first = pool.connector.link();
        let mut second = pool.connector.link();
        let headers = HashMap::new();
        let get = request("GET", &headers);

        let (response, _) = tokio::join!(pool.request(&get, Lane::Shared), answer(&mut first, "a"));
        response.unwrap();
        tokio::time::advance(REUSE_IDLE_LIMIT).await;
        let (response, _) =
            tokio::join!(pool.request(&get, Lane::Shared), answer(&mut second, "b"));

        assert_eq!(response.unwrap().body, b"b");
        assert_eq!(pool.connections_opened(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn retries_a_read_the_reused_connection_dropped_before_answering() {
        let pool = pool(Duration::from_secs(15));
        let mut first = pool.connector.link();
        let mut second = pool.connector.link();
        let headers = HashMap::new();
        let get = request("GET", &headers);

        let (response, _) = tokio::join!(pool.request(&get, Lane::Shared), answer(&mut first, "a"));
        response.unwrap();
        let (response, _, _) = tokio::join!(
            pool.request(&get, Lane::Shared),
            async move {
                read_head(&mut first).await;
            },
            answer(&mut second, "retried")
        );

        assert_eq!(response.unwrap().body, b"retried");
        assert_eq!(pool.connections_opened(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn never_replays_a_mutation_the_reused_connection_dropped_before_answering() {
        let pool = pool(Duration::from_secs(15));
        let mut first = pool.connector.link();
        let _unused = pool.connector.link();
        let headers = HashMap::new();
        let get = request("GET", &headers);
        let post = request("POST", &headers);

        let (response, _) = tokio::join!(pool.request(&get, Lane::Shared), answer(&mut first, "a"));
        response.unwrap();
        let (response, _) = tokio::join!(pool.request(&post, Lane::Shared), async move {
            read_head(&mut first).await;
        });

        assert!(
            outcome_unknown_because(&response, "closed before a response"),
            "{response:?}"
        );
        assert_eq!(pool.connections_opened(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn never_replays_a_mutation_cut_off_while_it_was_being_written() {
        let pool = pool(Duration::from_secs(15));
        let mut first = pool.connector.link_with(8, None);
        let _unused = pool.connector.link();
        let headers = HashMap::new();
        let get = request("GET", &headers);
        let post = request("POST", &headers);

        let (response, _) = tokio::join!(pool.request(&get, Lane::Shared), answer(&mut first, "a"));
        response.unwrap();
        let (response, _) = tokio::join!(pool.request(&post, Lane::Shared), async move {
            let mut prefix = [0; 8];
            first.read_exact(&mut prefix).await.unwrap();
        });

        assert!(
            outcome_unknown_because(&response, "could not write the request"),
            "{response:?}"
        );
        assert_eq!(pool.connections_opened(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn retries_a_mutation_that_could_not_be_sent_at_all() {
        let pool = pool(Duration::from_secs(15));
        let mut first = pool.connector.link();
        let mut second = pool.connector.link();
        let headers = HashMap::new();
        let get = request("GET", &headers);
        let post = request("POST", &headers);

        let (response, _) = tokio::join!(pool.request(&get, Lane::Shared), answer(&mut first, "a"));
        response.unwrap();
        drop(first);
        let (response, head) = tokio::join!(
            pool.request(&post, Lane::Shared),
            answer(&mut second, "created")
        );

        assert_eq!(response.unwrap().body, b"created");
        assert!(head.starts_with("POST /v1/info HTTP/1.1\r\n"), "{head}");
        assert_eq!(pool.connections_opened(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn reports_an_unknown_outcome_when_the_answer_to_a_mutation_is_cut_off() {
        let pool = pool(Duration::from_secs(15));
        let mut server = pool.connector.link();
        let headers = HashMap::new();
        let post = request("POST", &headers);

        let (response, _) = tokio::join!(pool.request(&post, Lane::Shared), async move {
            read_head(&mut server).await;
            server
                .write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 10\r\n\r\npart")
                .await
                .unwrap();
        });

        assert!(
            outcome_unknown_because(&response, "truncated response"),
            "{response:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reports_an_unknown_outcome_when_a_sent_mutation_times_out() {
        let pool = pool(Duration::from_secs(1));
        let mut silent = pool.connector.link();
        let headers = HashMap::new();
        let post = request("POST", &headers);

        let (response, _) = tokio::join!(pool.request(&post, Lane::Shared), read_head(&mut silent));

        assert!(
            outcome_unknown_because(&response, "did not respond within 1s"),
            "{response:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn backs_off_from_a_server_that_cannot_be_reached_on_both_lanes() {
        let pool = pool(Duration::from_secs(15));
        let failure = LinkFailure {
            message: "the bridge exited with code 4: no server".into(),
            permanent: true,
        };
        drop(pool.connector.link_with(4096, Some(failure.clone())));
        let headers = HashMap::new();
        let get = request("GET", &headers);
        let post = request("POST", &headers);

        let first = pool.request(&post, Lane::Shared).await;
        let shared = pool.request(&get, Lane::Shared).await;
        let dedicated = pool.request(&post, Lane::Dedicated).await;
        for response in [&first, &shared, &dedicated] {
            assert!(
                matches!(response, Err(PoolError::Unavailable(f)) if *f == failure),
                "{response:?}"
            );
        }
        assert_eq!(pool.connections_opened(), 1);

        tokio::time::advance(UNAVAILABLE_BACKOFF).await;
        let mut server = pool.connector.link();
        let (recovered, _) =
            tokio::join!(pool.request(&get, Lane::Shared), answer(&mut server, "up"));
        assert_eq!(recovered.unwrap().body, b"up");
        assert_eq!(pool.connections_opened(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_timed_out_read_leaves_no_connection_behind() {
        let pool = pool(Duration::from_secs(1));
        let mut silent = pool.connector.link();
        let mut second = pool.connector.link();
        let headers = HashMap::new();
        let get = request("GET", &headers);

        let (response, _) = tokio::join!(pool.request(&get, Lane::Shared), read_head(&mut silent));
        assert!(
            matches!(response, Err(PoolError::TimedOut(_))),
            "{response:?}"
        );
        let (response, _) =
            tokio::join!(pool.request(&get, Lane::Shared), answer(&mut second, "b"));

        assert_eq!(response.unwrap().body, b"b");
        assert_eq!(pool.connections_opened(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_dedicated_request_does_not_wait_for_the_shared_connection() {
        let pool = Arc::new(pool(Duration::from_secs(15)));
        let _stuck = pool.connector.link();
        let mut dedicated = pool.connector.link();
        let blocked = tokio::spawn({
            let pool = Arc::clone(&pool);
            async move {
                let headers = HashMap::new();
                pool.request(&request("GET", &headers), Lane::Shared)
                    .await
                    .is_ok()
            }
        });
        tokio::time::sleep(Duration::from_millis(1)).await;

        let headers = HashMap::new();
        let post = request("POST", &headers);
        let (response, head) = tokio::join!(
            pool.request(&post, Lane::Dedicated),
            answer(&mut dedicated, "done")
        );

        assert_eq!(response.unwrap().body, b"done");
        assert!(head.contains("Connection: close"), "{head}");
        assert!(!blocked.is_finished());
        blocked.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_shared_requests_beyond_the_queue_limit() {
        let pool = Arc::new(pool(Duration::from_secs(15)));
        let _stuck = pool.connector.link();
        let waiting: Vec<_> = (0..QUEUE_LIMIT)
            .map(|_| {
                let pool = Arc::clone(&pool);
                tokio::spawn(async move {
                    let headers = HashMap::new();
                    pool.request(&request("GET", &headers), Lane::Shared)
                        .await
                        .is_ok()
                })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(1)).await;

        let headers = HashMap::new();
        let refused = pool.request(&request("GET", &headers), Lane::Shared).await;

        assert!(matches!(refused, Err(PoolError::Busy)), "{refused:?}");
        for task in waiting {
            task.abort();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_an_invalid_request_without_opening_a_connection() {
        let pool = pool(Duration::from_secs(15));
        let headers = HashMap::new();
        let invalid = Request {
            path: "no-slash",
            ..request("GET", &headers)
        };

        let response = pool.request(&invalid, Lane::Shared).await;

        assert!(
            matches!(
                response,
                Err(PoolError::Http {
                    error: HttpError::InvalidPath,
                    diagnosis: None
                })
            ),
            "{response:?}"
        );
        assert_eq!(pool.connections_opened(), 0);
    }

    fn spawn_request(
        pool: &Arc<HttpPool<FakeConnector>>,
        method: &'static str,
        lane: Lane,
    ) -> tokio::task::JoinHandle<Result<Response, PoolError>> {
        let pool = Arc::clone(pool);
        tokio::spawn(async move {
            let headers = HashMap::new();
            pool.request(&request(method, &headers), lane).await
        })
    }

    #[tokio::test(start_paused = true)]
    async fn closing_abandons_the_active_request_and_never_sends_the_queued_one() {
        let pool = Arc::new(pool(Duration::from_secs(15)));
        let mut stuck = pool.connector.link();
        let _never_opened = pool.connector.link();

        let active = spawn_request(&pool, "GET", Lane::Shared);
        let head = read_head(&mut stuck).await;
        let queued = spawn_request(&pool, "POST", Lane::Shared);
        tokio::time::sleep(Duration::from_millis(1)).await;
        pool.close();

        let active = active.await.unwrap();
        let queued = queued.await.unwrap();
        assert!(matches!(active, Err(PoolError::Closed)), "{active:?}");
        assert!(matches!(queued, Err(PoolError::Closed)), "{queued:?}");
        assert!(head.starts_with("GET "), "{head}");
        assert!(stuck.read_u8().await.is_err());
        assert_eq!(pool.connections_opened(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn closing_reports_an_unknown_outcome_for_a_mutation_already_sent() {
        for lane in [Lane::Shared, Lane::Dedicated] {
            let pool = Arc::new(pool(Duration::from_secs(15)));
            let mut server = pool.connector.link();

            let pending = spawn_request(&pool, "POST", lane);
            read_head(&mut server).await;
            pool.close();
            let response = pending.await.unwrap();

            assert!(
                outcome_unknown_because(&response, "connection was closed"),
                "{lane:?} {response:?}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_every_request_once_closed() {
        let pool = pool(Duration::from_secs(15));
        let _unused = pool.connector.link();
        pool.close();
        let headers = HashMap::new();

        for lane in [Lane::Shared, Lane::Dedicated] {
            let response = pool.request(&request("POST", &headers), lane).await;
            assert!(matches!(response, Err(PoolError::Closed)), "{response:?}");
        }
        assert!(pool.is_closed());
        assert_eq!(pool.connections_opened(), 0);
    }
}
