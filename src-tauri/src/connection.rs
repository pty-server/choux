use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, protocol::CloseFrame, Message};

use crate::transport::{
    bridge::CommandSpec,
    http::{HttpConnection, Request},
    pool::{HttpPool, Lane, PoolError},
    response::Response,
    target::{Route, Target},
    Endpoint, WebSocket,
};

pub const PTYS_HOST: &str = "ptys.local";
const REQUEST_DEADLINE: Duration = Duration::from_secs(15);
const SOCKET_OPEN_DEADLINE: Duration = Duration::from_secs(15);
const UNRETAINED_TARGET: &str = "This ptys connection is no longer configured in Choux.";

type Pool = HttpPool<Endpoint>;
type SocketSenders = HashMap<String, mpsc::UnboundedSender<Message>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    body: String,
}

impl From<Response> for HttpResponse {
    fn from(response: Response) -> Self {
        Self {
            status: response.status,
            status_text: response.reason,
            body: String::from_utf8_lossy(&response.body).into_owned(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SocketEvent {
    r#type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl SocketEvent {
    fn with_data(r#type: &'static str, data: String) -> Self {
        Self {
            r#type,
            data: Some(data),
            code: None,
            reason: None,
        }
    }

    fn opened() -> Self {
        Self {
            r#type: "open",
            data: None,
            code: None,
            reason: None,
        }
    }

    fn closed(code: u16, reason: Option<String>) -> Self {
        Self {
            r#type: "close",
            data: None,
            code: Some(code),
            reason,
        }
    }
}

#[derive(Default)]
struct Registration {
    holders: usize,
    pool: Option<Arc<Pool>>,
}

#[derive(Default)]
pub struct ConnectionHub {
    next_socket_id: AtomicU64,
    sockets: Mutex<SocketSenders>,
    registrations: Mutex<HashMap<Target, Registration>>,
}

impl ConnectionHub {
    fn retain(&self, target: &Target) {
        lock(&self.registrations)
            .entry(target.clone())
            .or_default()
            .holders += 1;
    }

    fn release(&self, target: &Target) -> Option<Arc<Pool>> {
        let mut registrations = lock(&self.registrations);
        let registration = registrations.get_mut(target)?;
        registration.holders -= 1;
        if registration.holders > 0 {
            return None;
        }
        registrations
            .remove(target)
            .and_then(|registration| registration.pool)
            .inspect(|pool| pool.close())
    }

    fn check_retained(&self, target: &Target) -> Result<(), String> {
        if lock(&self.registrations).contains_key(target) {
            Ok(())
        } else {
            Err(UNRETAINED_TARGET.into())
        }
    }

    fn pool(&self, target: &Target, spec: CommandSpec) -> Result<Arc<Pool>, String> {
        let mut registrations = lock(&self.registrations);
        let registration = registrations.get_mut(target).ok_or(UNRETAINED_TARGET)?;
        let pool = registration.pool.get_or_insert_with(|| {
            Arc::new(HttpPool::new(Endpoint::Command(spec), REQUEST_DEADLINE))
        });
        Ok(Arc::clone(pool))
    }

    fn sockets(&self) -> MutexGuard<'_, SocketSenders> {
        lock(&self.sockets)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn endpoint_for(route: Route) -> Result<Endpoint, String> {
    match route {
        Route::Local(instance) => crate::local_server::socket_endpoint(&instance).await,
        Route::Bridge(spec) => Ok(Endpoint::Command(spec)),
    }
}

pub async fn local_http_request(
    endpoint: &Endpoint,
    request: &Request<'_>,
) -> Result<Response, String> {
    let exchange = async {
        let stream = endpoint
            .connect()
            .await
            .map_err(|error| format!("could not connect to local ptys: {error}"))?;
        HttpConnection::new(stream)
            .send(request)
            .await
            .map_err(|error| format!("local ptys request failed: {error}"))
    };
    tokio::time::timeout(REQUEST_DEADLINE, exchange)
        .await
        .map_err(|_| {
            format!(
                "local ptys did not respond within {}s",
                REQUEST_DEADLINE.as_secs()
            )
        })?
}

#[tauri::command]
pub async fn ptys_request(
    hub: State<'_, ConnectionHub>,
    target: Target,
    path: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    lane: Option<Lane>,
) -> Result<HttpResponse, String> {
    let headers = headers.unwrap_or_default();
    let request = Request {
        method: method.as_deref().unwrap_or("GET"),
        path: &path,
        host: PTYS_HOST,
        headers: &headers,
        body: body.as_deref().map(str::as_bytes),
        keep_alive: false,
    };
    let response = match target.route()? {
        Route::Local(instance) => {
            let endpoint = crate::local_server::socket_endpoint(&instance).await?;
            local_http_request(&endpoint, &request).await?
        }
        Route::Bridge(spec) => hub
            .pool(&target, spec)?
            .request(&request, lane.unwrap_or(Lane::Shared))
            .await
            .map_err(|error| match error {
                PoolError::Closed => UNRETAINED_TARGET.to_string(),
                error => error.to_string(),
            })?,
    };
    Ok(response.into())
}

#[tauri::command]
pub fn ptys_transport_retain(hub: State<'_, ConnectionHub>, target: Target) {
    hub.retain(&target);
}

#[tauri::command]
pub fn ptys_transport_release(hub: State<'_, ConnectionHub>, target: Target) {
    drop(hub.release(&target));
}

#[tauri::command]
pub async fn ptys_socket_open(
    app: AppHandle,
    hub: State<'_, ConnectionHub>,
    target: Target,
    path: String,
    protocols: Vec<String>,
    channel: String,
) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err("invalid ptys WebSocket path".into());
    }
    let route = target.route()?;
    if matches!(route, Route::Bridge(_)) {
        hub.check_retained(&target)?;
    }
    let url = format!("ws://{}.{PTYS_HOST}{path}", target.instance());
    let endpoint = endpoint_for(route).await?;
    let connection_id = format!(
        "socket-{}",
        hub.next_socket_id.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = mpsc::unbounded_channel::<Message>();
    hub.sockets().insert(connection_id.clone(), sender);
    let task_connection_id = connection_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = relay_socket(&app, &channel, endpoint, &url, protocols, receiver).await
        {
            let _ = app.emit(&channel, SocketEvent::with_data("error", error));
        }
        app.state::<ConnectionHub>()
            .sockets()
            .remove(&task_connection_id);
    });
    Ok(connection_id)
}

async fn open_socket(
    endpoint: Endpoint,
    url: &str,
    protocols: Vec<String>,
    outgoing: &mut mpsc::UnboundedReceiver<Message>,
    deadline: Duration,
) -> Result<Option<WebSocket>, String> {
    let handshake = async {
        let mut request = url
            .into_client_request()
            .map_err(|error| error.to_string())?;
        if !protocols.is_empty() {
            let value = protocols
                .join(", ")
                .parse()
                .map_err(|_| "invalid WebSocket protocol")?;
            request
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", value);
        }
        endpoint.open_websocket(request).await
    };
    tokio::select! {
        opened = tokio::time::timeout(deadline, handshake) => match opened {
            Ok(socket) => socket.map(Some),
            Err(_) => Err(format!(
                "the ptys connection did not open within {}s",
                deadline.as_secs()
            )),
        },
        _ = outgoing.recv() => Ok(None),
    }
}

async fn relay_socket(
    app: &AppHandle,
    channel: &str,
    endpoint: Endpoint,
    url: &str,
    protocols: Vec<String>,
    mut outgoing: mpsc::UnboundedReceiver<Message>,
) -> Result<(), String> {
    let Some(WebSocket {
        stream: socket,
        process: _bridge,
    }) = open_socket(
        endpoint,
        url,
        protocols,
        &mut outgoing,
        SOCKET_OPEN_DEADLINE,
    )
    .await?
    else {
        return Ok(());
    };
    app.emit(channel, SocketEvent::opened())
        .map_err(|error| error.to_string())?;
    let (mut write, mut read) = socket.split();
    loop {
        tokio::select! {
            message = outgoing.recv() => match message {
                Some(message) => write.send(message).await.map_err(|error| error.to_string())?,
                None => return Ok(()),
            },
            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let _ = app.emit(channel, SocketEvent::with_data("text", text.to_string()));
                }
                Some(Ok(Message::Binary(data))) => {
                    let _ = app.emit(channel, SocketEvent::with_data("binary", BASE64.encode(data)));
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map_or((1000, None), |frame| {
                        (frame.code.into(), Some(frame.reason.to_string()))
                    });
                    let _ = app.emit(channel, SocketEvent::closed(code, reason));
                    return Ok(());
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.to_string()),
                None => {
                    let _ = app.emit(channel, SocketEvent::closed(1006, None));
                    return Ok(());
                }
            }
        }
    }
}

#[tauri::command]
pub fn ptys_socket_send(
    hub: State<'_, ConnectionHub>,
    connection_id: String,
    text: Option<String>,
    binary: Option<String>,
) -> Result<(), String> {
    let message = match (text, binary) {
        (Some(text), None) => Message::Text(text),
        (None, Some(binary)) => Message::Binary(
            BASE64
                .decode(binary)
                .map_err(|_| "invalid binary WebSocket frame")?,
        ),
        _ => return Err("exactly one WebSocket frame payload is required".into()),
    };
    hub.sockets()
        .get(&connection_id)
        .ok_or("The ptys socket is closed.")?
        .send(message)
        .map_err(|_| "The ptys socket is closed.".into())
}

#[tauri::command]
pub fn ptys_socket_close(
    hub: State<'_, ConnectionHub>,
    connection_id: String,
    code: Option<u16>,
    reason: Option<String>,
) {
    if let Some(sender) = hub.sockets().remove(&connection_id) {
        let _ = sender.send(Message::Close(code.map(|code| CloseFrame {
            code: code.into(),
            reason: reason.unwrap_or_default().into(),
        })));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(node_bin: Option<&str>) -> Target {
        Target::Ssh {
            host: "box".into(),
            instance: "default".into(),
            node_bin: node_bin.map(String::from),
        }
    }

    fn spec(target: &Target) -> CommandSpec {
        match target.route() {
            Ok(Route::Bridge(spec)) => spec,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn keeps_one_pool_per_target_only_while_something_retains_it() {
        let hub = ConnectionHub::default();
        let plain = ssh(None);
        let with_node = ssh(Some("/opt/node/bin"));

        assert!(hub.pool(&plain, spec(&plain)).is_err());
        assert!(hub.check_retained(&plain).is_err());
        hub.retain(&plain);
        hub.retain(&plain);
        hub.retain(&with_node);

        let first = hub.pool(&plain, spec(&plain)).unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &hub.pool(&plain, spec(&plain)).unwrap()
        ));
        assert!(!Arc::ptr_eq(
            &first,
            &hub.pool(&with_node, spec(&with_node)).unwrap()
        ));

        assert!(hub.release(&plain).is_none());
        assert!(Arc::ptr_eq(
            &first,
            &hub.pool(&plain, spec(&plain)).unwrap()
        ));
        assert!(!first.is_closed());
        assert!(hub.release(&plain).is_some());
        assert!(first.is_closed());
        assert!(hub.pool(&plain, spec(&plain)).is_err());
        assert!(hub.release(&plain).is_none());
        assert!(hub.check_retained(&with_node).is_ok());
    }

    #[cfg(unix)]
    fn shell_bridge(script: &str) -> Endpoint {
        Endpoint::Command(CommandSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
            diagnostics: crate::transport::bridge::Diagnostics::Plain,
        })
    }

    #[cfg(unix)]
    async fn open_events(
        bridge: Endpoint,
        receiver: &mut mpsc::UnboundedReceiver<Message>,
        deadline: Duration,
    ) -> Result<Option<WebSocket>, String> {
        open_socket(
            bridge,
            "ws://default.ptys.local/v1/events",
            Vec::new(),
            receiver,
            deadline,
        )
        .await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn abandons_a_stalled_handshake_once_the_socket_is_closed() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = sender.send(Message::Close(None));
        });

        let opened = tokio::time::timeout(
            Duration::from_secs(5),
            open_events(
                shell_bridge("exec sleep 30"),
                &mut receiver,
                Duration::from_secs(30),
            ),
        )
        .await
        .expect("closing the socket did not cancel its handshake");

        assert!(matches!(opened, Ok(None)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gives_up_on_a_handshake_that_never_answers() {
        let (_sender, mut receiver) = mpsc::unbounded_channel();

        let opened = open_events(
            shell_bridge("exec sleep 30"),
            &mut receiver,
            Duration::from_millis(200),
        )
        .await;

        match opened {
            Err(message) => assert!(message.contains("did not open"), "{message}"),
            Ok(_) => panic!("a silent bridge opened a WebSocket"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_why_a_bridge_could_not_carry_the_handshake() {
        let (_sender, mut receiver) = mpsc::unbounded_channel();

        let opened = open_events(
            shell_bridge("echo 'ptys bridge: no server is running' >&2; exit 4"),
            &mut receiver,
            Duration::from_secs(5),
        )
        .await;

        match opened {
            Err(message) => assert_eq!(
                message,
                "the bridge exited with code 4: ptys bridge: no server is running"
            ),
            Ok(_) => panic!("a failed bridge opened a WebSocket"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_the_server_answer_when_a_healthy_bridge_refuses_the_upgrade() {
        let (_sender, mut receiver) = mpsc::unbounded_channel();

        let opened = open_events(
            shell_bridge(
                "head -c 1 >/dev/null; printf 'HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\n\\r\\n'",
            ),
            &mut receiver,
            Duration::from_secs(5),
        )
        .await;

        match opened {
            Err(message) => assert!(
                message.contains("404") && !message.contains("bridge"),
                "{message}"
            ),
            Ok(_) => panic!("a refused upgrade opened a WebSocket"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn requests_over_a_unix_socket_without_waiting_for_the_close() {
        use std::{env, fs};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::UnixListener,
        };

        let dir = env::temp_dir().join(format!("choux-local-http-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let socket_path = dir.join("ptys.sock");
        let _ = fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"pid\":\r\n3\r\n42}\r\n0\r\n\r\n")
                .await
                .unwrap();
            (String::from_utf8(request).unwrap(), stream)
        });

        let headers = HashMap::new();
        let request = Request {
            method: "GET",
            path: "/v1/daemon",
            host: PTYS_HOST,
            headers: &headers,
            body: None,
            keep_alive: false,
        };
        let response = local_http_request(&Endpoint::UnixSocket(socket_path), &request)
            .await
            .unwrap();
        let (request, _open_stream) = server.await.unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(
            request,
            "GET /v1/daemon HTTP/1.1\r\nHost: ptys.local\r\nConnection: close\r\n\r\n"
        );
        assert_eq!(
            (
                response.status,
                response.reason.as_str(),
                response.body.as_slice()
            ),
            (200, "OK", b"{\"pid\":42}".as_slice())
        );
    }
}
