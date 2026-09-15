use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
};

#[cfg(unix)]
use std::collections::HashMap;

use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;

mod connection;
mod locale;
mod transport;

use locale::user_locale;
#[cfg(unix)]
use transport::{http::Request, target::valid_instance, Endpoint};

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
#[serde(rename_all = "camelCase")]
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

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_dir())
}

fn ptys_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ptys"))
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

const ENV_MARKER: &str = "__choux_env__";
const SHELL_ENV_VARS: [&str; 4] = ["PATH", "LC_ALL", "LC_CTYPE", "LANG"];

#[cfg(not(target_os = "windows"))]
fn login_shell_env() -> Vec<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let reads = SHELL_ENV_VARS
        .iter()
        .map(|name| format!("printf '%s\\n' \"${{{name}-}}\""))
        .collect::<Vec<_>>()
        .join("; ");
    let script = format!("printf {ENV_MARKER}; {reads}; printf {ENV_MARKER}");
    for flags in ["-lic", "-lc", "-c"] {
        let Ok(output) = Command::new(&shell)
            .args([flags, script.as_str()])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        else {
            continue;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let Some(block) = stdout.split(ENV_MARKER).nth(1) else {
            continue;
        };
        let values: Vec<String> = block
            .split('\n')
            .take(SHELL_ENV_VARS.len())
            .map(|value| value.trim().to_string())
            .collect();
        if values.len() == SHELL_ENV_VARS.len() && !values[0].is_empty() {
            return values;
        }
    }
    Vec::new()
}

#[cfg(target_os = "windows")]
fn login_shell_env() -> Vec<String> {
    Vec::new()
}

pub(crate) fn shell_var(name: &str) -> Option<&'static str> {
    static SHELL_ENV: OnceLock<Vec<String>> = OnceLock::new();
    let index = SHELL_ENV_VARS
        .iter()
        .position(|candidate| *candidate == name)?;
    SHELL_ENV
        .get_or_init(login_shell_env)
        .get(index)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

fn version_bin_dirs(root: &PathBuf) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .collect();
    versions.sort();
    versions.reverse();
    versions
        .into_iter()
        .flat_map(|version| [version.join("bin"), version.join("installation/bin")])
        .collect()
}

fn common_tool_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
    ];
    if let Some(home) = home_dir() {
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.extend(version_bin_dirs(&home.join(".nvm/versions/node")));
        dirs.extend(version_bin_dirs(
            &home.join(".local/share/fnm/node-versions"),
        ));
        dirs.extend(version_bin_dirs(
            &home.join("Library/Application Support/fnm/node-versions"),
        ));
    }
    dirs
}

fn user_path() -> &'static str {
    static USER_PATH: OnceLock<String> = OnceLock::new();
    USER_PATH.get_or_init(|| {
        let separator = if cfg!(target_os = "windows") {
            ';'
        } else {
            ':'
        };
        let mut dirs: Vec<PathBuf> = Vec::new();
        let sources = [shell_var("PATH").map(str::to_string), env::var("PATH").ok()];
        for source in sources.iter().flatten() {
            dirs.extend(source.split(separator).map(PathBuf::from));
        }
        dirs.extend(common_tool_dirs());
        let mut seen: Vec<String> = Vec::new();
        for dir in dirs {
            let text = dir.display().to_string();
            if !text.is_empty() && !seen.contains(&text) && dir.is_dir() {
                seen.push(text);
            }
        }
        seen.join(&separator.to_string())
    })
}

fn user_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.env("PATH", user_path()).stdin(Stdio::null());
    if let Some(home) = home_dir() {
        command.current_dir(home);
    }
    for (name, value) in user_locale() {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    command
}

fn resolve_in_user_path(name: &str) -> Option<PathBuf> {
    let separator = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };
    user_path()
        .split(separator)
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|candidate| candidate.is_file())
}

fn npm_available() -> bool {
    user_command("npm")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn node_available() -> bool {
    resolve_in_user_path("node").is_some()
}

fn resolve_ptys() -> Result<PathBuf, String> {
    if let Some(path) = resolve_in_user_path("ptys") {
        return Ok(path);
    }

    #[cfg(target_os = "windows")]
    let lookup = "where";
    #[cfg(not(target_os = "windows"))]
    let lookup = "which";

    let output = user_command(lookup)
        .arg("ptys")
        .output()
        .map_err(|_| "Unable to check PATH for ptys.".to_string())?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout.lines().map(str::trim).find(|line| !line.is_empty()) {
            return Ok(PathBuf::from(path));
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
async fn local_daemon_matches(socket_path: &str, pid: u32) -> bool {
    let endpoint = Endpoint::UnixSocket(socket_path.into());
    let headers = HashMap::new();
    let request = Request {
        method: "GET",
        path: "/v1/daemon",
        host: connection::PTYS_HOST,
        headers: &headers,
        body: None,
        keep_alive: false,
    };
    let Ok(response) = connection::local_http_request(&endpoint, &request).await else {
        return false;
    };
    response.status == 200
        && serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
            == Some(pid as u64)
}

#[cfg(not(unix))]
async fn local_daemon_matches(_socket_path: &str, _pid: u32) -> bool {
    false
}

#[cfg(unix)]
async fn local_socket_for_instance(instance: &str) -> Result<Endpoint, String> {
    if !valid_instance(instance) {
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
    if !process_alive(pid as u32) || !local_daemon_matches(socket_path, pid as u32).await {
        return Err(format!(
            "No live local ptys daemon is running as instance {instance}."
        ));
    }
    Ok(Endpoint::UnixSocket(socket_path.into()))
}

async fn local_server_candidate(value: &serde_json::Value) -> Option<LocalServerCandidate> {
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
        && local_daemon_matches(socket_path, pid as u32).await)
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

    #[tokio::test]
    async fn rejects_a_pidfile_without_a_live_control_socket() {
        assert!(local_server_candidate(&pidfile()).await.is_none());
    }

    #[tokio::test]
    async fn rejects_legacy_host_port_metadata() {
        assert!(
            local_server_candidate(&json!({ "host": "127.0.0.1", "port": 7801 }))
                .await
                .is_none()
        );
    }
}

#[tauri::command]
async fn local_server_candidates() -> Vec<LocalServerCandidate> {
    let Some(run_dir) = ptys_dir().map(|path| path.join("run")) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(run_dir) else {
        return Vec::new();
    };
    let pidfiles: Vec<serde_json::Value> = entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "pid")
        })
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str(&text).ok())
        .collect();
    let mut candidates = Vec::new();
    for pidfile in &pidfiles {
        candidates.extend(local_server_candidate(pidfile).await);
    }
    candidates
}

#[tauri::command(async)]
fn local_server_tool() -> LocalServerTool {
    match resolve_ptys() {
        Ok(executable) => LocalServerTool {
            available: true,
            npm_available: npm_available(),
            executable: Some(executable.display().to_string()),
            message: (!node_available()).then(|| {
                "ptys was found, but Node.js is not on PATH. Install Node.js, or launch Choux from a terminal that has it."
                    .to_string()
            }),
        },
        Err(message) => LocalServerTool {
            available: false,
            npm_available: npm_available(),
            executable: None,
            message: Some(message),
        },
    }
}

#[tauri::command(async)]
fn local_server_install() -> LocalServerCommandResult {
    let output = match user_command("npm")
        .args(["install", "--global", "@pty-server/ptys@latest"])
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

#[tauri::command(async)]
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
    if !node_available() {
        return LocalServerCommandResult {
            ok: false,
            message: Some(
                "Node.js is not on PATH, so ptys cannot run. Install Node.js, or launch Choux from a terminal that has it."
                    .into(),
            ),
        };
    }
    let output = match user_command(executable).args(["server", "start"]).output() {
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

#[tauri::command(async)]
fn local_server_home() -> Option<String> {
    home_dir().and_then(|home| home.into_os_string().into_string().ok())
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
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    #[cfg(target_os = "linux")]
    present_main_window(app);
}

#[cfg(target_os = "linux")]
fn present_main_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        use gtk::prelude::{Cast, GtkWindowExt, WidgetExt};
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        let Ok(gtk_window) = window.gtk_window() else {
            return;
        };
        gtk_window.deiconify();
        let timestamp = gtk_window
            .window()
            .and_then(|gdk_window| gdk_window.downcast::<gdkx11::X11Window>().ok())
            .map(|x11_window| {
                let now = gdkx11::functions::x11_get_server_time(&x11_window);
                x11_window.set_user_time(now);
                now
            })
            .unwrap_or(0);
        gtk_window.present_with_time(timestamp);
    });
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

fn build_main_window(app: &AppHandle) -> Result<WebviewWindow, Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("tauri.conf.json defines no main window")?;
    let builder = WebviewWindowBuilder::from_config(app, config)?;
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 22.0));
    Ok(builder.build()?)
}

fn hide_to_tray(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
        }
        #[cfg(not(target_os = "linux"))]
        WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
            let _ = window.unminimize();
            let _ = window.hide();
        }
        _ => {}
    }
}

fn enclosing_app_bundle(executable: &Path) -> Option<&Path> {
    executable.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension == "app")
    })
}

#[cfg(unix)]
fn on_read_only_volume(path: &Path) -> bool {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};

    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stats = MaybeUninit::<libc::statvfs>::uninit();
    unsafe {
        libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) == 0
            && stats.assume_init_ref().f_flag & libc::ST_RDONLY != 0
    }
}

#[cfg(not(unix))]
fn on_read_only_volume(_path: &Path) -> bool {
    false
}

#[tauri::command]
fn app_bundle_read_only() -> bool {
    env::current_exe()
        .ok()
        .and_then(|executable| enclosing_app_bundle(&executable).map(on_read_only_volume))
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().manage(connection::ConnectionHub::default());

    // Linux opens a protocol activation in a new process. This plugin forwards
    // it to the existing window and exits the new process instead.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        builder = builder.plugin(tauri_plugin_process::init());
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let show = MenuItem::with_id(app, SHOW_MENU_ID, "Show Choux", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            // Load the RGBA source directly. This preserves transparent corners
            // in the tray and window icon instead of relying on a generated
            // platform icon cached during a previous build.
            let app_icon = Image::from_bytes(include_bytes!("../icons/128x128@2x.png"))?;
            let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            build_main_window(app.handle())?.set_icon(app_icon.clone())?;
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("choux")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    SHOW_MENU_ID => show_main_window(app),
                    QUIT_MENU_ID => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Static registration handles installed DEBs. Runtime registration
            // additionally covers dev builds and AppImages moved after launch.
            #[cfg(target_os = "linux")]
            app.deep_link().register_all()?;

            Ok(())
        })
        .on_window_event(hide_to_tray)
        .invoke_handler(tauri::generate_handler![
            token_get,
            token_set,
            token_delete,
            global_shortcut_set,
            local_server_candidates,
            local_server_tool,
            local_server_install,
            local_server_start,
            local_server_home,
            connection::ptys_request,
            connection::ptys_transport_retain,
            connection::ptys_transport_release,
            connection::ptys_socket_open,
            connection::ptys_socket_send,
            connection::ptys_socket_close,
            app_bundle_read_only,
        ])
        .run(tauri::generate_context!())
        .expect("error while running choux");
}

#[cfg(test)]
mod payload_tests {
    use super::*;

    #[test]
    fn local_server_tool_serializes_the_keys_the_client_reads() {
        let payload = serde_json::to_value(LocalServerTool {
            available: false,
            npm_available: true,
            executable: None,
            message: None,
        })
        .expect("serializable");

        assert_eq!(payload.get("npmAvailable"), Some(&serde_json::json!(true)));
        assert_eq!(payload.get("npm_available"), None);
    }
}

#[cfg(test)]
mod app_bundle_tests {
    use super::*;

    #[test]
    fn finds_the_app_bundle_around_the_executable() {
        assert_eq!(
            enclosing_app_bundle(Path::new("/Volumes/choux/choux.app/Contents/MacOS/choux")),
            Some(Path::new("/Volumes/choux/choux.app"))
        );
    }

    #[test]
    fn finds_no_app_bundle_for_a_bare_executable() {
        assert_eq!(enclosing_app_bundle(Path::new("/usr/bin/choux")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_writable_directory_is_not_on_a_read_only_volume() {
        assert!(!on_read_only_volume(&env::temp_dir()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_read_only_bind_mount_is_detected() {
        use std::os::unix::ffi::OsStrExt;

        let Ok(mounts) = fs::read_to_string("/proc/self/mountinfo") else {
            return;
        };
        let read_only_mount = mounts.lines().find_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let options = fields.get(5)?;
            let mount_point = Path::new(fields.get(4)?);
            let usable =
                !mount_point.as_os_str().as_bytes().contains(&b'\\') && mount_point.exists();
            (usable && options.split(',').any(|option| option == "ro"))
                .then(|| mount_point.to_path_buf())
        });
        if let Some(mount_point) = read_only_mount {
            assert!(
                on_read_only_volume(&mount_point),
                "{mount_point:?} is mounted ro"
            );
        }
    }
}
