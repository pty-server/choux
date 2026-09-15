use std::{env, path::Path};

use keyring::{Entry, Error as KeyringError};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
#[cfg(target_os = "linux")]
use tauri_plugin_deep_link::DeepLinkExt;

mod connection;
mod local_server;
#[cfg(unix)]
mod locale;
mod transport;
mod wsl;

const TOKEN_SERVICE: &str = "ptys-choux";
const SHOW_MENU_ID: &str = "show";
const QUIT_MENU_ID: &str = "quit";

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
            local_server::local_server_candidates,
            local_server::local_server_tool,
            local_server::local_server_install,
            local_server::local_server_start,
            local_server::local_server_home,
            wsl::wsl_supported,
            wsl::wsl_status,
            wsl::wsl_probe,
            wsl::wsl_candidates,
            wsl::wsl_install,
            wsl::wsl_start,
            wsl::wsl_home,
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
        use std::{fs, os::unix::ffi::OsStrExt};

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
