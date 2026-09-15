use super::{LocalServerCandidate, LocalServerCommandResult, LocalServerTool};
use crate::transport::Endpoint;

const UNSUPPORTED: &str = "Local ptys servers are not supported on Windows; run ptys inside WSL.";

pub async fn socket_endpoint(_instance: &str) -> Result<Endpoint, String> {
    Err(UNSUPPORTED.into())
}

pub async fn candidates() -> Vec<LocalServerCandidate> {
    Vec::new()
}

pub fn tool() -> LocalServerTool {
    LocalServerTool {
        available: false,
        npm_available: false,
        executable: None,
        message: Some(UNSUPPORTED.into()),
    }
}

pub fn install() -> LocalServerCommandResult {
    refused()
}

pub fn start() -> LocalServerCommandResult {
    refused()
}

pub fn home() -> Option<String> {
    None
}

fn refused() -> LocalServerCommandResult {
    LocalServerCommandResult {
        ok: false,
        message: Some(UNSUPPORTED.into()),
    }
}
