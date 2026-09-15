use serde::Serialize;

use crate::transport::Endpoint;

#[cfg(unix)]
mod unix;
#[cfg(not(unix))]
mod unsupported;

#[cfg(unix)]
use unix as platform;
#[cfg(unix)]
pub(crate) use unix::shell_var;
#[cfg(not(unix))]
use unsupported as platform;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerCandidate {
    instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    listen: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerTool {
    available: bool,
    npm_available: bool,
    executable: Option<String>,
    message: Option<String>,
}

#[derive(Serialize)]
pub struct LocalServerCommandResult {
    ok: bool,
    message: Option<String>,
}

pub async fn socket_endpoint(instance: &str) -> Result<Endpoint, String> {
    platform::socket_endpoint(instance).await
}

#[tauri::command]
pub async fn local_server_candidates() -> Vec<LocalServerCandidate> {
    platform::candidates().await
}

#[tauri::command(async)]
pub fn local_server_tool() -> LocalServerTool {
    platform::tool()
}

#[tauri::command(async)]
pub fn local_server_install() -> LocalServerCommandResult {
    platform::install()
}

#[tauri::command(async)]
pub fn local_server_start() -> LocalServerCommandResult {
    platform::start()
}

#[tauri::command(async)]
pub fn local_server_home() -> Option<String> {
    platform::home()
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
