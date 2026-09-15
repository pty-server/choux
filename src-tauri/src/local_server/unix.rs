use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::OnceLock,
};

use super::{LocalServerCandidate, LocalServerCommandResult, LocalServerTool};
use crate::{
    connection::{local_http_request, PTYS_HOST},
    locale::user_locale,
    transport::{http::Request, target::valid_instance, Endpoint},
};

const ENV_MARKER: &str = "__choux_env__";
const SHELL_ENV_VARS: [&str; 4] = ["PATH", "LC_ALL", "LC_CTYPE", "LANG"];

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
        let mut dirs: Vec<PathBuf> = Vec::new();
        let sources = [shell_var("PATH").map(str::to_string), env::var("PATH").ok()];
        for source in sources.iter().flatten() {
            dirs.extend(source.split(':').map(PathBuf::from));
        }
        dirs.extend(common_tool_dirs());
        let mut seen: Vec<String> = Vec::new();
        for dir in dirs {
            let text = dir.display().to_string();
            if !text.is_empty() && !seen.contains(&text) && dir.is_dir() {
                seen.push(text);
            }
        }
        seen.join(":")
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
    user_path()
        .split(':')
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

    let output = user_command("which")
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
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn local_daemon_matches(socket_path: &str, pid: u32) -> bool {
    let endpoint = Endpoint::UnixSocket(socket_path.into());
    let headers = HashMap::new();
    let request = Request {
        method: "GET",
        path: "/v1/daemon",
        host: PTYS_HOST,
        headers: &headers,
        body: None,
        keep_alive: false,
    };
    let Ok(response) = local_http_request(&endpoint, &request).await else {
        return false;
    };
    response.status == 200
        && serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
            == Some(pid as u64)
}

pub async fn socket_endpoint(instance: &str) -> Result<Endpoint, String> {
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

pub async fn candidates() -> Vec<LocalServerCandidate> {
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

pub fn tool() -> LocalServerTool {
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

pub fn install() -> LocalServerCommandResult {
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

pub fn start() -> LocalServerCommandResult {
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

pub fn home() -> Option<String> {
    home_dir().and_then(|home| home.into_os_string().into_string().ok())
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
