use std::{collections::HashMap, env, process::Stdio, time::Duration};

use tokio::process::Command;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use super::{
    alive_daemons,
    gate::DistroGate,
    inspect,
    run::{running_distros, WslRunning},
    start_daemon, wsl_status, Refusal, WslHost,
};
use crate::{
    connection::ConnectionHub,
    transport::{
        http::Request,
        pool::{HttpPool, Lane},
        target::{Route, Target, SYSTEM_PATH},
        Endpoint,
    },
};

const INSTANCE: &str = "choux-test-host";
const DEADLINE: Duration = Duration::from_secs(30);
const SETTLE: Duration = Duration::from_secs(2);

struct Distro {
    name: String,
    user: String,
    node_bin: String,
}

impl Distro {
    fn from_env() -> Self {
        let read = |name: &str| {
            env::var(name).unwrap_or_else(|_| panic!("set {name} to run the WSL host tests"))
        };
        Self {
            name: read("CHOUX_WSL_DISTRO"),
            user: read("CHOUX_WSL_USER"),
            node_bin: read("CHOUX_WSL_NODE_BIN"),
        }
    }

    fn host(&self) -> WslHost {
        WslHost {
            distro: self.name.clone(),
            user: self.user.clone(),
            node_bin: Some(self.node_bin.clone()),
        }
    }

    fn target(&self) -> Target {
        Target::Wsl {
            distro: self.name.clone(),
            user: self.user.clone(),
            instance: INSTANCE.into(),
            node_bin: Some(self.node_bin.clone()),
        }
    }

    async fn stop_daemon(&self) {
        let path = format!("PATH={}:{SYSTEM_PATH}", self.node_bin);
        wsl(&[
            "-d",
            &self.name,
            "-u",
            &self.user,
            "--exec",
            "env",
            &path,
            "ptys",
            "server",
            "stop",
            "--instance",
            INSTANCE,
        ])
        .await;
    }
}

async fn wsl(args: &[&str]) -> std::process::Output {
    Command::new("wsl.exe")
        .args(args)
        .env("WSL_UTF8", "1")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "needs WSL with ptys; set CHOUX_WSL_DISTRO, CHOUX_WSL_USER and CHOUX_WSL_NODE_BIN"]
async fn reports_a_supported_wsl_and_the_installed_distribution() {
    let distro = Distro::from_env();

    let status = wsl_status().await;

    assert!(status.supported && status.problem.is_none(), "{status:?}");
    assert!(
        status
            .distros
            .iter()
            .any(|listed| listed.name == distro.name && listed.version == Some(2)),
        "{status:?}"
    );
}

#[tokio::test]
#[ignore = "needs WSL with ptys; set CHOUX_WSL_DISTRO, CHOUX_WSL_USER and CHOUX_WSL_NODE_BIN"]
async fn finds_the_user_home_node_and_ptys_of_a_distribution() {
    let distro = Distro::from_env();

    let probe = inspect(distro.name.clone(), None, None).await.unwrap();

    assert_eq!(probe.user, distro.user);
    assert_eq!(probe.home, Some(format!("/home/{}", distro.user)));
    assert_eq!(probe.node_bin.as_deref(), Some(distro.node_bin.as_str()));
    assert!(probe.node_available && probe.npm_available, "{probe:?}");
    assert!(probe.ptys_version.is_some(), "{probe:?}");
    assert_eq!(probe.message, None);
}

#[tokio::test]
#[ignore = "needs WSL with ptys; set CHOUX_WSL_DISTRO, CHOUX_WSL_USER and CHOUX_WSL_NODE_BIN"]
async fn starts_a_daemon_that_serves_a_bridge_once_its_launcher_is_gone() {
    let distro = Distro::from_env();
    distro.stop_daemon().await;

    let started = start_daemon(distro.host(), INSTANCE.into()).await;
    let alive = alive_daemons(&distro.host()).await;
    let started_again = start_daemon(distro.host(), INSTANCE.into()).await;
    let Ok(Route::Bridge(spec)) = distro.target().route() else {
        panic!("the WSL target has no bridge route");
    };
    let pool = HttpPool::new(Endpoint::Command(spec), DEADLINE);
    let headers = HashMap::new();
    let info = pool
        .request(
            &Request {
                method: "GET",
                path: "/v1/info",
                host: "ptys.local",
                headers: &headers,
                body: None,
                keep_alive: true,
            },
            Lane::Shared,
        )
        .await
        .map(|response| response.status)
        .map_err(|error| error.to_string());
    distro.stop_daemon().await;

    assert_eq!(started, Ok(()));
    assert!(
        alive
            .as_ref()
            .is_ok_and(|instances| instances.iter().any(|instance| instance == INSTANCE)),
        "{alive:?}"
    );
    assert_eq!(started_again, Ok(()));
    assert_eq!(info, Ok(200));
}

#[tokio::test]
#[ignore = "needs WSL with ptys; set CHOUX_WSL_DISTRO, CHOUX_WSL_USER and CHOUX_WSL_NODE_BIN"]
async fn a_stopped_distribution_is_refused_without_being_started() {
    let distro = Distro::from_env();
    assert!(wsl(&["--terminate", &distro.name]).await.status.success());

    let refused = DistroGate::<WslRunning>::default()
        .check(&distro.name)
        .await;
    let hub = ConnectionHub::default();
    let guarded_probe = inspect(distro.name.clone(), None, Some(&hub)).await;
    let status = wsl_status().await;
    tokio::time::sleep(SETTLE).await;
    let running = running_distros().await.unwrap();

    assert_eq!(refused, Err(Refusal::NotRunning(distro.name.clone())));
    assert_eq!(
        guarded_probe.err(),
        Some(format!("WSL distribution {} is not running.", distro.name))
    );
    assert!(
        status
            .distros
            .iter()
            .any(|listed| listed.name == distro.name && !listed.running),
        "{status:?}"
    );
    assert!(!running.contains(&distro.name), "{running:?}");
}
