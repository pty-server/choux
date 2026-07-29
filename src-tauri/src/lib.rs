use std::{env, fs, path::PathBuf, process::Command};

#[cfg(unix)]
use std::{
    collections::HashMap,
    io::{Read, Write},
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

#[cfg(unix)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(unix)]
use futures_util::{SinkExt, StreamExt};
use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
#[cfg(unix)]
use tauri::Emitter;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Window, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
#[cfg(unix)]
use tokio::sync::mpsc;
#[cfg(unix)]
use tokio_tungstenite::{
    client_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const TOKEN_SERVICE: &str = "ptys-choux";
const SHOW_MENU_ID: &str = "show";
const QUIT_MENU_ID: &str = "quit";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalServerCandidate {
    instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    listen: Option<Vec<String>>,
}

#[derive(Serialize)]
struct LocalServerTool {
    available: bool,
    npm_available: bool,
    executable: Option<String>,
    message: Option<String>,
}

#[derive(Serialize)]
struct LocalServerCommandResult {
    ok: bool,
    message: Option<String>,
}

fn ptys_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(|home| PathBuf::from(home).join(".ptys"))
}

fn command_message(output: &std::process::Output) -> Option<String> {
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(1200).collect())
}

fn npm_available() -> bool {
    Command::new("npm")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn resolve_ptys() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let lookup = "where";
    #[cfg(not(target_os = "windows"))]
    let lookup = "which";

    let output = Command::new(lookup)
        .arg("ptys")
        .output()
        .map_err(|_| "Unable to check PATH for ptys.".to_string())?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout.lines().map(str::trim).find(|line| !line.is_empty()) {
            return Ok(PathBuf::from(path));
        }
    }

    // Graphical launchers may have a smaller PATH than the user's terminal.
    // A login shell restores the normal per-user command environment without
    // assuming a particular install directory or package manager.
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("sh")
            .args(["-lc", "command -v ptys"])
            .output()
            .map_err(|_| "Unable to check PATH for ptys.".to_string())?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(path) = stdout
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty())
            {
                return Ok(PathBuf::from(path));
            }
        }
    }

    Err("ptys is not available on PATH.".into())
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHttpResponse {
    status: u16,
    status_text: String,
    body: String,
}

#[cfg(unix)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSocketEvent {
    r#type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[cfg(unix)]
#[derive(Default)]
struct LocalSocketHub {
    next_id: AtomicU64,
    senders: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
}

#[cfg(unix)]
fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut rest = body;
    let mut decoded = Vec::new();
    loop {
        let Some(line_end) = rest.windows(2).position(|window| window == b"\r\n") else {
            return Err("invalid chunked response".into());
        };
        let size = std::str::from_utf8(&rest[..line_end])
            .map_err(|_| "invalid chunk size")?
            .split(';')
            .next()
            .unwrap_or_default();
        let size = usize::from_str_radix(size.trim(), 16).map_err(|_| "invalid chunk size")?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok(decoded);
        }
        if rest.len() < size + 2 {
            return Err("truncated chunked response".into());
        }
        decoded.extend_from_slice(&rest[..size]);
        if &rest[size..size + 2] != b"\r\n" {
            return Err("invalid chunk delimiter".into());
        }
        rest = &rest[size + 2..];
    }
}

#[cfg(unix)]
fn unix_http_request(
    socket_path: &str,
    path: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> Result<LocalHttpResponse, String> {
    if !path.starts_with('/') || path.contains('\r') || path.contains('\n') {
        return Err("invalid local ptys request path".into());
    }
    let mut stream = UnixStream::connect(socket_path)
        .map_err(|error| format!("could not connect to local ptys: {error}"))?;
    let payload = body.unwrap_or("");
    let mut request =
        format!("{method} {path} HTTP/1.1\r\nHost: ptys.local\r\nConnection: close\r\n");
    for (name, value) in headers {
        if name.contains('\r')
            || name.contains('\n')
            || value.contains('\r')
            || value.contains('\n')
        {
            return Err("invalid local ptys request header".into());
        }
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    if body.is_some() {
        request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(payload.as_bytes()))
        .map_err(|error| format!("could not write to local ptys: {error}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| format!("could not read from local ptys: {error}"))?;
    let Some(headers_end) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err("invalid HTTP response from local ptys".into());
    };
    let header_text = std::str::from_utf8(&raw[..headers_end])
        .map_err(|_| "invalid HTTP headers from local ptys")?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines.next().ok_or("missing HTTP status from local ptys")?;
    let mut status_parts = status_line.splitn(3, ' ');
    let _http = status_parts.next();
    let status = status_parts
        .next()
        .ok_or("missing HTTP status code")?
        .parse::<u16>()
        .map_err(|_| "invalid HTTP status code")?;
    let status_text = status_parts.next().unwrap_or_default().to_owned();
    let chunked = lines.any(|line| {
        line.to_ascii_lowercase().starts_with("transfer-encoding:")
            && line.to_ascii_lowercase().contains("chunked")
    });
    let response_body = if chunked {
        decode_chunked(&raw[headers_end + 4..])?
    } else {
        raw[headers_end + 4..].to_vec()
    };
    Ok(LocalHttpResponse {
        status,
        status_text,
        body: String::from_utf8_lossy(&response_body).into_owned(),
    })
}

#[cfg(unix)]
fn local_daemon_matches(socket_path: &str, pid: u32) -> bool {
    let Ok(response) = unix_http_request(socket_path, "/v1/daemon", "GET", &HashMap::new(), None)
    else {
        return false;
    };
    response.status == 200
        && serde_json::from_str::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
            == Some(pid as u64)
}

#[cfg(not(unix))]
fn local_daemon_matches(_socket_path: &str, _pid: u32) -> bool {
    false
}

#[cfg(unix)]
fn local_socket_for_instance(instance: &str) -> Result<String, String> {
    let valid_instance = !instance.is_empty()
        && instance.len() <= 64
        && instance.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        });
    if !valid_instance {
        return Err("Invalid local ptys instance name.".into());
    }
    let run_dir = ptys_dir()
        .ok_or("Could not locate the ptys runtime directory.")?
        .join("run");
    let pidfile = run_dir.join(format!("{instance}.pid"));
    let text = fs::read_to_string(pidfile)
        .map_err(|_| format!("No local ptys daemon is running as instance {instance}."))?;
    let value = serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|_| "Invalid ptys runtime metadata.".to_string())?;
    let pid = value
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .ok_or("Invalid ptys runtime metadata.")?;
    let socket_path = value
        .get("controlSocketPath")
        .and_then(serde_json::Value::as_str)
        .ok_or("This ptys daemon does not expose a control socket; upgrade ptys and restart it.")?;
    if !process_alive(pid as u32) || !local_daemon_matches(socket_path, pid as u32) {
        return Err(format!(
            "No live local ptys daemon is running as instance {instance}."
        ));
    }
    Ok(socket_path.to_owned())
}

fn local_server_candidate(value: &serde_json::Value) -> Option<LocalServerCandidate> {
    let instance = value.get("instance")?.as_str()?.to_owned();
    let pid = value.get("pid")?.as_u64()?;
    let socket_path = value.get("controlSocketPath")?.as_str()?;
    let running = value.get("running")?;
    let configured = running.get("listen")?.as_array()?;
    let listen = value
        .get("listen")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(configured)
        .iter()
        .filter_map(|address| {
            Some(format!(
                "{}:{}",
                address.get("host")?.as_str()?,
                address.get("port")?.as_u64()?
            ))
        })
        .collect::<Vec<_>>();
    (!instance.is_empty()
        && pid > 0
        && pid <= u32::MAX as u64
        && process_alive(pid as u32)
        && local_daemon_matches(socket_path, pid as u32))
    .then_some(LocalServerCandidate {
        instance,
        listen: (!listen.is_empty()).then_some(listen),
    })
}

#[cfg(test)]
mod local_server_candidate_tests {
    use super::*;
    use serde_json::json;

    fn pidfile() -> serde_json::Value {
        json!({
            "instance": "default",
            "pid": std::process::id(),
            "controlSocketPath": "/not-a-live-socket",
            "running": { "listen": [] },
        })
    }

    #[test]
    fn rejects_a_pidfile_without_a_live_control_socket() {
        assert!(local_server_candidate(&pidfile()).is_none());
    }

    #[test]
    fn rejects_legacy_host_port_metadata() {
        assert!(local_server_candidate(&json!({ "host": "127.0.0.1", "port": 7801 })).is_none());
    }
}

#[tauri::command]
fn local_server_candidates() -> Vec<LocalServerCandidate> {
    let Some(run_dir) = ptys_dir().map(|path| path.join("run")) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(run_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "pid")
        })
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter_map(|value| local_server_candidate(&value))
        .collect()
}

#[tauri::command]
fn local_server_tool() -> LocalServerTool {
    match resolve_ptys() {
        Ok(executable) => LocalServerTool {
            available: true,
            npm_available: npm_available(),
            executable: Some(executable.display().to_string()),
            message: None,
        },
        Err(message) => LocalServerTool {
            available: false,
            npm_available: npm_available(),
            executable: None,
            message: Some(message),
        },
    }
}

#[tauri::command]
fn local_server_install() -> LocalServerCommandResult {
    let output = match Command::new("npm")
        .args(["install", "--global", "ptys@latest"])
        .output()
    {
        Ok(output) => output,
        Err(_) => {
            return LocalServerCommandResult {
                ok: false,
                message: Some("npm is not available on PATH.".into()),
            }
        }
    };
    if !output.status.success() {
        return LocalServerCommandResult {
            ok: false,
            message: command_message(&output).or(Some("npm could not install ptys.".into())),
        };
    }
    match resolve_ptys() {
        Ok(_) => LocalServerCommandResult {
            ok: true,
            message: None,
        },
        Err(message) => LocalServerCommandResult {
            ok: false,
            message: Some(format!(
                "ptys installed, but Choux could not locate it: {message}"
            )),
        },
    }
}

#[tauri::command]
fn local_server_start() -> LocalServerCommandResult {
    let executable = match resolve_ptys() {
        Ok(executable) => executable,
        Err(message) => {
            return LocalServerCommandResult {
                ok: false,
                message: Some(message),
            }
        }
    };
    let output = match Command::new(executable).args(["server", "start"]).output() {
        Ok(output) => output,
        Err(error) => {
            return LocalServerCommandResult {
                ok: false,
                message: Some(format!("Could not start ptys: {error}")),
            }
        }
    };
    LocalServerCommandResult {
        ok: output.status.success(),
        message: (!output.status.success()).then(|| {
            command_message(&output).unwrap_or_else(|| "ptys could not start the daemon.".into())
        }),
    }
}

#[cfg(unix)]
#[tauri::command]
fn local_server_request(
    instance: String,
    path: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<LocalHttpResponse, String> {
    let socket_path = local_socket_for_instance(&instance)?;
    unix_http_request(
        &socket_path,
        &path,
        method.as_deref().unwrap_or("GET"),
        &headers.unwrap_or_default(),
        body.as_deref(),
    )
}

#[cfg(unix)]
#[tauri::command]
async fn local_socket_open(
    app: AppHandle,
    hub: tauri::State<'_, LocalSocketHub>,
    instance: String,
    path: String,
    protocols: Vec<String>,
    channel: String,
) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err("invalid local ptys WebSocket path".into());
    }
    let socket_path = local_socket_for_instance(&instance)?;
    let connection_id = format!("local-{}", hub.next_id.fetch_add(1, Ordering::Relaxed));
    let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
    hub.senders
        .lock()
        .map_err(|_| "Local socket state is unavailable.")?
        .insert(connection_id.clone(), sender);
    let task_connection_id = connection_id.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), String> = async {
            let stream = tokio::net::UnixStream::connect(socket_path).await.map_err(|error| error.to_string())?;
            let mut request = format!("ws://{instance}.ptys.local{path}").into_client_request().map_err(|error| error.to_string())?;
            if !protocols.is_empty() {
                request.headers_mut().insert("Sec-WebSocket-Protocol", protocols.join(", ").parse().map_err(|_| "invalid WebSocket protocol")?);
            }
            let (socket, _) = client_async(request, stream).await.map_err(|error| error.to_string())?;
            app.emit(&channel, LocalSocketEvent { r#type: "open", data: None, code: None, reason: None }).map_err(|error| error.to_string())?;
            let (mut write, mut read) = socket.split();
            loop {
                tokio::select! {
                    outgoing = receiver.recv() => match outgoing {
                        Some(message) => write.send(message).await.map_err(|error| error.to_string())?,
                        None => break,
                    },
                    incoming = read.next() => match incoming {
                        Some(Ok(Message::Text(text))) => { let _ = app.emit(&channel, LocalSocketEvent { r#type: "text", data: Some(text.to_string()), code: None, reason: None }); }
                        Some(Ok(Message::Binary(data))) => { let _ = app.emit(&channel, LocalSocketEvent { r#type: "binary", data: Some(BASE64.encode(data)), code: None, reason: None }); }
                        Some(Ok(Message::Close(frame))) => { let (code, reason) = frame.map(|f| (Some(f.code.into()), Some(f.reason.to_string()))).unwrap_or((Some(1000), None)); let _ = app.emit(&channel, LocalSocketEvent { r#type: "close", data: None, code, reason }); break; }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => return Err(error.to_string()),
                        None => { let _ = app.emit(&channel, LocalSocketEvent { r#type: "close", data: None, code: Some(1006), reason: None }); break; }
                    }
                }
            }
            Ok(())
        }.await;
        if let Err(error) = result {
            let _ = app.emit(
                &channel,
                LocalSocketEvent {
                    r#type: "error",
                    data: Some(error),
                    code: None,
                    reason: None,
                },
            );
        }
        if let Ok(mut senders) = app.state::<LocalSocketHub>().senders.lock() {
            senders.remove(&task_connection_id);
        }
    });
    Ok(connection_id)
}

#[cfg(unix)]
#[tauri::command]
fn local_socket_send(
    hub: tauri::State<'_, LocalSocketHub>,
    connection_id: String,
    text: Option<String>,
    binary: Option<String>,
) -> Result<(), String> {
    let message = match (text, binary) {
        (Some(text), None) => Message::Text(text.into()),
        (None, Some(binary)) => Message::Binary(
            BASE64
                .decode(binary)
                .map_err(|_| "invalid binary WebSocket frame")?
                .into(),
        ),
        _ => return Err("exactly one WebSocket frame payload is required".into()),
    };
    let senders = hub
        .senders
        .lock()
        .map_err(|_| "Local socket state is unavailable.")?;
    senders
        .get(&connection_id)
        .ok_or("Local socket is closed.")?
        .send(message)
        .map_err(|_| "Local socket is closed.".into())
}

#[cfg(unix)]
#[tauri::command]
fn local_socket_close(
    hub: tauri::State<'_, LocalSocketHub>,
    connection_id: String,
    code: Option<u16>,
    reason: Option<String>,
) {
    if let Ok(mut senders) = hub.senders.lock() {
        if let Some(sender) = senders.remove(&connection_id) {
            let _ = sender.send(Message::Close(code.map(|code| {
                tokio_tungstenite::tungstenite::protocol::CloseFrame {
                    code: code.into(),
                    reason: reason.unwrap_or_default().into(),
                }
            })));
        }
    }
}

fn valid_token_ref(token_ref: &str) -> bool {
    token_ref.len() == 36
        && token_ref.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn keyring_entry(token_ref: &str) -> Result<Entry, String> {
    if !valid_token_ref(token_ref) {
        return Err("Invalid native token reference.".into());
    }
    Entry::new(TOKEN_SERVICE, token_ref).map_err(|_| {
        "Native token storage is unavailable. Unlock your login keyring and try again.".into()
    })
}

#[tauri::command]
fn token_get(token_ref: String) -> Result<Option<String>, String> {
    let entry = keyring_entry(&token_ref)?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err(
            "Native token storage is unavailable. Unlock your login keyring and try again.".into(),
        ),
    }
}

#[tauri::command]
fn token_set(token_ref: String, token: String) -> Result<(), String> {
    if token.is_empty() {
        return Err("A server token is required.".into());
    }
    keyring_entry(&token_ref)?
        .set_password(&token)
        .map_err(|_| {
            "Native token storage is unavailable. Unlock your login keyring and try again.".into()
        })
}

#[tauri::command]
fn token_delete(token_ref: String) -> Result<(), String> {
    let entry = keyring_entry(&token_ref)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err(
            "Native token storage is unavailable. Unlock your login keyring and try again.".into(),
        ),
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let in_front = window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && window.is_focused().unwrap_or(false);
    if in_front {
        let _ = window.hide();
    } else {
        show_main_window(app);
    }
}

#[cfg(desktop)]
#[tauri::command]
fn global_shortcut_set(app: AppHandle, accelerator: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let shortcuts = app.global_shortcut();
    shortcuts
        .unregister_all()
        .map_err(|_| "Could not release the previous global shortcut.".to_string())?;
    let Some(accelerator) = accelerator.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    shortcuts
        .on_shortcut(accelerator.as_str(), |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        })
        .map_err(|_| {
            format!("{accelerator} is unavailable - another application may already use it.")
        })
}

#[cfg(not(desktop))]
#[tauri::command]
fn global_shortcut_set(_accelerator: Option<String>) -> Result<(), String> {
    Err("Global shortcuts are only available on desktop.".into())
}

fn hide_on_close(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(unix)]
    {
        builder = builder.manage(LocalSocketHub::default());
    }

    // Linux opens a protocol activation in a new process. This plugin forwards
    // it to the existing window and exits the new process instead.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let show = MenuItem::with_id(app, SHOW_MENU_ID, "Show Choux", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            // Load the RGBA source directly. This preserves transparent corners
            // in the tray and window icon instead of relying on a generated
            // platform icon cached during a previous build.
            let app_icon = Image::from_bytes(include_bytes!("../icons/128x128@2x.png"))?;
            let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(app_icon.clone())?;
            }
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("choux")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    SHOW_MENU_ID => show_main_window(app),
                    QUIT_MENU_ID => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Static registration handles installed DEBs. Runtime registration
            // additionally covers dev builds and AppImages moved after launch.
            #[cfg(target_os = "linux")]
            app.deep_link().register_all()?;

            Ok(())
        })
        .on_window_event(hide_on_close)
        .invoke_handler(tauri::generate_handler![
            token_get,
            token_set,
            token_delete,
            global_shortcut_set,
            local_server_candidates,
            local_server_tool,
            local_server_install,
            local_server_start,
            local_server_request,
            local_socket_open,
            local_socket_send,
            local_socket_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running choux");
}
