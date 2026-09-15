use std::{
    collections::HashMap,
    env,
    process::Stdio,
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, handshake::client::Request as HandshakeRequest,
};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use super::{
    http::Request,
    pool::{HttpPool, Lane, PoolError},
    process_tree::{all_exit_within, wait_for_tree, Holder},
    target::{Route, Target},
    Endpoint,
};

const DEADLINE: Duration = Duration::from_secs(15);
const EXIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(200);
const SYSTEM_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const HTTP_INSTANCE: &str = "choux-test-http";
const KILL_INSTANCE: &str = "choux-test-kill";
const PROBE_FOUND: i32 = 10;
const PROBE_MISSING: i32 = 11;

struct Distro {
    name: String,
    user: String,
    node_bin: String,
}

impl Distro {
    fn from_env() -> Self {
        let read = |name: &str| {
            env::var(name).unwrap_or_else(|_| panic!("set {name} to run the WSL bridge tests"))
        };
        Self {
            name: read("CHOUX_WSL_DISTRO"),
            user: read("CHOUX_WSL_USER"),
            node_bin: read("CHOUX_WSL_NODE_BIN"),
        }
    }

    fn target(&self, instance: &str) -> Target {
        Target::Wsl {
            distro: self.name.clone(),
            user: self.user.clone(),
            instance: instance.into(),
            node_bin: Some(self.node_bin.clone()),
        }
    }

    fn endpoint(&self, instance: &str) -> Endpoint {
        endpoint(&self.target(instance))
    }

    fn command(&self, args: &[&str]) -> Command {
        self.command_on_path(&format!("{}:{SYSTEM_PATH}", self.node_bin), args)
    }

    fn command_on_path(&self, path: &str, args: &[&str]) -> Command {
        let mut command = Command::new("wsl.exe");
        command
            .args([
                "-d",
                self.name.as_str(),
                "-u",
                self.user.as_str(),
                "--exec",
                "env",
            ])
            .arg(format!("PATH={path}"))
            .args(args)
            .env("WSL_UTF8", "1")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    async fn resolves_ptys_on_the_system_path(&self) -> bool {
        let script = format!(
            "if command -v ptys && command -v node; then exit {PROBE_FOUND}; fi; exit {PROBE_MISSING}"
        );
        let status = tokio::time::timeout(
            DEADLINE,
            self.command_on_path(SYSTEM_PATH, &["sh", "-c", &script])
                .stdout(Stdio::null())
                .status(),
        )
        .await
        .expect("the PATH probe in WSL did not finish")
        .unwrap();
        match status.code() {
            Some(PROBE_FOUND) => true,
            Some(PROBE_MISSING) => false,
            other => panic!("the PATH probe in WSL failed with {other:?}"),
        }
    }

    async fn bridges_running(&self, instance: &str) -> bool {
        let pattern = format!("ptys [b]ridge --instance {instance}");
        self.command(&["pgrep", "-f", &pattern])
            .stdout(Stdio::null())
            .status()
            .await
            .unwrap()
            .success()
    }
}

fn endpoint(target: &Target) -> Endpoint {
    match target.route() {
        Ok(Route::Bridge(spec)) => Endpoint::Command(spec),
        other => panic!("{other:?}"),
    }
}

fn get<'a>(path: &'a str, headers: &'a HashMap<String, String>) -> Request<'a> {
    Request {
        method: "GET",
        path,
        host: "ptys.local",
        headers,
        body: None,
        keep_alive: true,
    }
}

fn events_request(instance: &str) -> HandshakeRequest {
    format!("ws://{instance}.ptys.local/v1/events")
        .into_client_request()
        .unwrap()
}

struct WslServer(#[allow(dead_code)] Child);

impl WslServer {
    async fn start(distro: &Distro, instance: &str) -> Self {
        let mut child = distro
            .command(&["ptys", "server", "run", "--instance", instance])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::time::timeout(DEADLINE, async {
            while let Some(line) = lines.next_line().await.unwrap() {
                if line.contains("listening on unix:") {
                    return;
                }
            }
            panic!("the ptys server in WSL exited before listening");
        })
        .await
        .expect("the ptys server in WSL did not start listening");
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        Self(child)
    }
}

#[tokio::test]
#[ignore = "needs WSL with ptys; set CHOUX_WSL_DISTRO, CHOUX_WSL_USER and CHOUX_WSL_NODE_BIN"]
async fn serves_requests_and_events_through_the_wsl_preset() {
    let distro = Distro::from_env();
    let _server = WslServer::start(&distro, HTTP_INSTANCE).await;
    let pool = HttpPool::new(distro.endpoint(HTTP_INSTANCE), DEADLINE);
    let headers = HashMap::new();

    let response = pool
        .request(&get("/v1/info", &headers), Lane::Shared)
        .await
        .unwrap();
    let info: Value = serde_json::from_slice(&response.body).unwrap();
    let events = distro
        .endpoint(HTTP_INSTANCE)
        .open_websocket(events_request(HTTP_INSTANCE))
        .await;

    assert_eq!(response.status, 200);
    assert!(info["protocol"].is_u64(), "{info}");
    assert!(events.is_ok(), "{:?}", events.err());
}

#[tokio::test]
#[ignore = "needs WSL with ptys; set CHOUX_WSL_DISTRO, CHOUX_WSL_USER and CHOUX_WSL_NODE_BIN"]
async fn reports_what_keeps_a_wsl_bridge_from_starting() {
    let distro = Distro::from_env();
    let mut cases = vec![
        (
            Target::Wsl {
                distro: "ChouxNoSuchDistro".into(),
                user: distro.user.clone(),
                instance: "default".into(),
                node_bin: Some(distro.node_bin.clone()),
            },
            "WSL could not start the bridge: There is no distribution",
        ),
        (
            Target::Wsl {
                distro: distro.name.clone(),
                user: "chouxnosuchuser".into(),
                instance: "default".into(),
                node_bin: Some(distro.node_bin.clone()),
            },
            "WSL could not start the bridge: ",
        ),
    ];
    if !distro.resolves_ptys_on_the_system_path().await {
        cases.push((
            Target::Wsl {
                distro: distro.name.clone(),
                user: distro.user.clone(),
                instance: "default".into(),
                node_bin: Some("/choux/missing/bin".into()),
            },
            "the bridge exited with code 127: ",
        ));
    }
    let headers = HashMap::new();

    for (target, expected) in cases {
        let pool = HttpPool::new(endpoint(&target), DEADLINE);
        let request = pool.request(&get("/v1/info", &headers), Lane::Shared).await;
        let socket = endpoint(&target)
            .open_websocket(events_request("default"))
            .await;

        match request {
            Err(PoolError::Unavailable(failure)) => assert!(
                failure.permanent && failure.message.starts_with(expected),
                "{failure:?}"
            ),
            other => panic!("{expected}: {other:?}"),
        }
        match socket {
            Err(message) => assert!(message.starts_with(expected), "{message}"),
            Ok(_) => panic!("{expected}: the WebSocket opened"),
        }
    }
}

#[tokio::test]
#[ignore = "needs WSL with ptys; set CHOUX_WSL_DISTRO, CHOUX_WSL_USER and CHOUX_WSL_NODE_BIN"]
async fn a_killed_owner_leaves_no_wsl_bridge_behind() {
    let distro = Distro::from_env();
    let _server = WslServer::start(&distro, KILL_INSTANCE).await;
    let mut holder = Holder::start(module_path!(), "holds_wsl_bridges_until_killed");
    let tree = wait_for_tree(holder.id(), "wsl.exe", 4, DEADLINE);
    assert!(distro.bridges_running(KILL_INSTANCE).await);

    holder.kill();

    assert_eq!(all_exit_within(&tree, EXIT), Ok(()));
    let deadline = Instant::now() + EXIT;
    while distro.bridges_running(KILL_INSTANCE).await {
        assert!(
            Instant::now() < deadline,
            "a ptys bridge outlived its owner"
        );
        tokio::time::sleep(POLL).await;
    }
}

#[tokio::test]
#[ignore = "started by a_killed_owner_leaves_no_wsl_bridge_behind"]
async fn holds_wsl_bridges_until_killed() {
    if !Holder::requested() {
        return;
    }
    let distro = Distro::from_env();
    let pool = HttpPool::new(distro.endpoint(KILL_INSTANCE), DEADLINE);
    let headers = HashMap::new();
    pool.request(&get("/v1/info", &headers), Lane::Shared)
        .await
        .unwrap();
    let _events = distro
        .endpoint(KILL_INSTANCE)
        .open_websocket(events_request(KILL_INSTANCE))
        .await
        .unwrap();
    Holder::announce_ready();
    tokio::time::sleep(Duration::from_secs(60)).await;
}
