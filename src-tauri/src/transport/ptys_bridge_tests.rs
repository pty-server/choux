use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};
use tokio_tungstenite::{
    client_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use super::{
    bridge::CommandSpec,
    http::Request,
    pool::{Connector, HttpPool, Lane, PoolError},
    target::{Route, Target},
    Endpoint,
};

const DEADLINE: Duration = Duration::from_secs(15);
const PTYS_ENVIRONMENT: [&str; 4] = [
    "PTYS_SERVER",
    "PTYS_INSTANCE",
    "PTYS_TOKEN",
    "XDG_RUNTIME_DIR",
];

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

fn private_directory(label: &str) -> PathBuf {
    let directory = env::temp_dir().join(format!(
        "choux-{label}-{}-{}",
        std::process::id(),
        NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn assignment(name: &str, value: &Path) -> OsString {
    let mut pair = OsString::from(format!("{name}="));
    pair.push(value);
    pair
}

struct PtysServer {
    cli: PathBuf,
    home: PathBuf,
    sockets: PathBuf,
    process: Option<Child>,
}

impl PtysServer {
    async fn start() -> Self {
        let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ptys/dist/cli.js");
        assert!(
            cli.is_file(),
            "build the sibling ptys checkout first: {}",
            cli.display()
        );
        let mut server = Self {
            cli,
            home: private_directory("home"),
            sockets: private_directory("sockets"),
            process: None,
        };
        server.launch().await;
        server
    }

    async fn launch(&mut self) {
        let mut command = Command::new("node");
        for name in PTYS_ENVIRONMENT {
            command.env_remove(name);
        }
        let mut child = command
            .arg(&self.cli)
            .arg("server")
            .env("HOME", &self.home)
            .env("PTYS_SOCKET_DIR", &self.sockets)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::time::timeout(DEADLINE, async {
            while let Some(line) = lines.next_line().await.unwrap() {
                if line.contains("listening on unix:") {
                    return;
                }
            }
            panic!("ptys server exited before listening");
        })
        .await
        .expect("ptys server did not start listening");
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        self.process = Some(child);
    }

    async fn restart(&mut self) {
        let mut child = self.process.take().unwrap();
        let pid = child.id().unwrap() as libc::pid_t;
        assert_eq!(unsafe { libc::kill(pid, libc::SIGTERM) }, 0);
        tokio::time::timeout(DEADLINE, child.wait())
            .await
            .unwrap()
            .unwrap();
        self.launch().await;
    }

    fn bridge(&self, instance: &str) -> Endpoint {
        let mut args: Vec<OsString> = PTYS_ENVIRONMENT
            .iter()
            .flat_map(|name| ["-u".into(), (*name).into()])
            .collect();
        args.extend([
            assignment("HOME", &self.home),
            assignment("PTYS_SOCKET_DIR", &self.sockets),
            "node".into(),
            self.cli.clone().into(),
            "bridge".into(),
            "--instance".into(),
            instance.into(),
        ]);
        Endpoint::Command(CommandSpec {
            program: "env".into(),
            args,
            env: Vec::new(),
        })
    }
}

impl Drop for PtysServer {
    fn drop(&mut self) {
        drop(self.process.take());
        let _ = fs::remove_dir_all(&self.home);
        let _ = fs::remove_dir_all(&self.sockets);
    }
}

struct ScratchDirectory(PathBuf);

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn node_executable() -> String {
    let output = std::process::Command::new("sh")
        .args(["-c", "command -v node"])
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn request<'a>(
    method: &'a str,
    path: &'a str,
    headers: &'a HashMap<String, String>,
    body: Option<&'a [u8]>,
) -> Request<'a> {
    Request {
        method,
        path,
        host: "ptys.local",
        headers,
        body,
        keep_alive: true,
    }
}

async fn get_json<C: Connector>(pool: &HttpPool<C>, path: &str) -> Value {
    let headers = HashMap::new();
    let response = pool
        .request(&request("GET", path, &headers, None), Lane::Shared)
        .await
        .unwrap();
    assert_eq!(response.status, 200, "GET {path}");
    serde_json::from_slice(&response.body).unwrap()
}

async fn post_json<C: Connector>(
    pool: &HttpPool<C>,
    path: &str,
    body: Value,
    lane: Lane,
) -> (u16, Value) {
    let headers = HashMap::from([("Content-Type".to_string(), "application/json".to_string())]);
    let body = body.to_string();
    let response = pool
        .request(
            &request("POST", path, &headers, Some(body.as_bytes())),
            lane,
        )
        .await
        .unwrap();
    (
        response.status,
        serde_json::from_slice(&response.body).unwrap_or(Value::Null),
    )
}

#[tokio::test]
#[ignore = "needs a built ../ptys checkout; run through npm run test:integration"]
async fn keeps_one_bridge_warm_and_replaces_it_after_the_idle_close() {
    let server = PtysServer::start().await;
    let pool = HttpPool::new(server.bridge("default"), DEADLINE);

    assert!(get_json(&pool, "/v1/info").await["protocol"].is_u64());
    get_json(&pool, "/v1/sessions").await;
    assert_eq!(pool.connections_opened(), 1);

    tokio::time::sleep(Duration::from_millis(6500)).await;
    get_json(&pool, "/v1/workspaces").await;
    assert_eq!(pool.connections_opened(), 2);
}

#[tokio::test]
#[ignore = "needs a built ../ptys checkout; run through npm run test:integration"]
async fn creates_and_lists_a_workspace_through_a_bridge() {
    let server = PtysServer::start().await;
    let pool = HttpPool::new(server.bridge("default"), DEADLINE);
    let home = server.home.to_str().unwrap();

    let (status, created) = post_json(
        &pool,
        "/v1/workspaces",
        json!({ "path": home }),
        Lane::Shared,
    )
    .await;
    let workspaces = get_json(&pool, "/v1/workspaces").await;

    assert_eq!(status, 200, "{created}");
    assert!(
        workspaces
            .as_array()
            .unwrap()
            .iter()
            .any(|workspace| workspace["id"] == created["id"]),
        "{workspaces}"
    );
}

#[tokio::test]
#[ignore = "needs a built ../ptys checkout; run through npm run test:integration"]
async fn reaches_a_restarted_server_on_a_new_bridge() {
    let mut server = PtysServer::start().await;
    let pool = HttpPool::new(server.bridge("default"), DEADLINE);
    let before = get_json(&pool, "/v1/daemon").await;

    server.restart().await;
    let after = get_json(&pool, "/v1/daemon").await;

    assert_ne!(before["pid"], after["pid"]);
    assert_eq!(pool.connections_opened(), 2);
}

#[tokio::test]
#[ignore = "needs a built ../ptys checkout; run through npm run test:integration"]
async fn reaches_a_server_through_the_exact_ssh_preset_command() {
    let server = PtysServer::start().await;
    let shims = ScratchDirectory(private_directory("shims"));
    write_script(
        &shims.0.join("ssh"),
        "while [ \"$1\" != -- ]; do shift; done\nshift 2\nexec sh -c \"$1\"",
    );
    let unset: String = PTYS_ENVIRONMENT
        .iter()
        .map(|name| format!("-u {name} "))
        .collect();
    write_script(
        &shims.0.join("ptys"),
        &format!(
            "exec env {unset}HOME='{}' PTYS_SOCKET_DIR='{}' '{}' '{}' \"$@\"",
            server.home.display(),
            server.sockets.display(),
            node_executable(),
            server.cli.display(),
        ),
    );
    let target = Target::Ssh {
        host: "me@box".into(),
        instance: "default".into(),
        node_bin: Some(shims.0.to_str().unwrap().into()),
    };
    let Ok(Route::Bridge(mut spec)) = target.route() else {
        panic!("the SSH preset did not build a bridge");
    };
    let mut path = OsString::from(&shims.0);
    path.push(":");
    path.push(env::var_os("PATH").unwrap_or_default());
    spec.env.push(("PATH".into(), path));
    let pool = HttpPool::new(Endpoint::Command(spec), DEADLINE);

    assert!(get_json(&pool, "/v1/info").await["protocol"].is_u64());
}

#[tokio::test]
#[ignore = "needs a built ../ptys checkout; run through npm run test:integration"]
async fn reports_a_missing_instance_and_backs_off() {
    let server = PtysServer::start().await;
    let pool = HttpPool::new(server.bridge("missing"), DEADLINE);
    let headers = HashMap::new();
    let get = request("GET", "/v1/info", &headers, None);

    let first = pool.request(&get, Lane::Shared).await;
    let second = pool.request(&get, Lane::Shared).await;

    match first {
        Err(PoolError::Unavailable(failure)) => {
            assert!(failure.permanent);
            assert!(
                failure
                    .message
                    .starts_with("the bridge exited with code 3: "),
                "{}",
                failure.message
            );
        }
        other => panic!("{other:?}"),
    }
    assert!(
        matches!(second, Err(PoolError::Unavailable(_))),
        "{second:?}"
    );
    assert_eq!(pool.connections_opened(), 1);
}

#[tokio::test]
#[ignore = "needs a built ../ptys checkout; run through npm run test:integration"]
async fn streams_events_on_their_own_bridge_and_keeps_exec_off_the_shared_one() {
    let server = PtysServer::start().await;
    let pool = HttpPool::new(server.bridge("default"), DEADLINE);
    let events_request = "ws://default.ptys.local/v1/events"
        .into_client_request()
        .unwrap();
    let events_link = server.bridge("default").connect().await.unwrap();
    let (mut events, upgrade) = client_async(events_request, events_link).await.unwrap();
    assert_eq!(upgrade.status(), 101);

    let (status, session) = post_json(
        &pool,
        "/v1/sessions",
        json!({ "cmd": "cat", "cols": 80, "rows": 24 }),
        Lane::Shared,
    )
    .await;
    assert!((200..300).contains(&status), "{status} {session}");
    let created = tokio::time::timeout(DEADLINE, async {
        while let Some(message) = events.next().await {
            if let Message::Text(text) = message.unwrap() {
                let frame: Value = serde_json::from_str(&text).unwrap();
                if frame["event"]["type"] == "session.created" {
                    return frame["event"]["sessionId"].clone();
                }
            }
        }
        panic!("the event stream ended");
    })
    .await
    .unwrap();
    assert_eq!(created, session["id"]);

    let exec_path = format!("/v1/sessions/{}/exec", session["id"].as_str().unwrap());
    let exec_finished = AtomicBool::new(false);
    let exec = async {
        let result = post_json(
            &pool,
            &exec_path,
            json!({ "cmd": "sleep", "args": ["2"] }),
            Lane::Dedicated,
        )
        .await;
        exec_finished.store(true, Ordering::SeqCst);
        result
    };
    let poll = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        get_json(&pool, "/v1/info").await;
        exec_finished.load(Ordering::SeqCst)
    };
    let ((exec_status, exec_result), exec_finished_before_poll) = tokio::join!(exec, poll);

    assert_eq!(exec_status, 200, "{exec_result}");
    assert_eq!(exec_result["code"], 0, "{exec_result}");
    assert!(!exec_finished_before_poll);
    events.close(None).await.unwrap();
}
