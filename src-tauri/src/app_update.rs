use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
#[cfg(desktop)]
use tauri::{AppHandle, State, Url};
#[cfg(desktop)]
use tauri_plugin_updater::{Update, UpdaterExt};

pub const STABLE_ENDPOINT: &str =
    "https://github.com/pty-server/choux/releases/latest/download/latest.json";
pub const RC_ENDPOINT: &str =
    "https://github.com/pty-server/choux/releases/download/rc/latest.json";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Rc,
}

impl UpdateChannel {
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_ENDPOINT,
            Self::Rc => RC_ENDPOINT,
        }
    }
}

#[derive(Serialize)]
pub struct OfferedUpdate {
    pub version: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadProgress {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

#[cfg(desktop)]
#[derive(Default)]
pub struct PendingUpdate(std::sync::Mutex<Option<Update>>);

#[cfg(not(desktop))]
#[derive(Default)]
pub struct PendingUpdate;

#[cfg(desktop)]
const NOTHING_TO_INSTALL: &str = "No update is ready to install.";

#[cfg(desktop)]
const SUPERSEDED: &str = "That update is no longer the one on offer. Check again.";

#[cfg(not(desktop))]
const UNSUPPORTED: &str = "Choux cannot update itself on this platform.";

#[cfg(desktop)]
#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    channel: UpdateChannel,
) -> Result<Option<OfferedUpdate>, String> {
    let endpoint = Url::parse(channel.endpoint()).map_err(|error| error.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let found = updater.check().await.map_err(|error| error.to_string())?;
    let offered = found.as_ref().map(|update| OfferedUpdate {
        version: update.version.clone(),
    });
    *pending.0.lock().unwrap() = found;
    Ok(offered)
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn app_update_check(_channel: UpdateChannel) -> Result<Option<OfferedUpdate>, String> {
    Err(UNSUPPORTED.into())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn app_update_install(
    pending: State<'_, PendingUpdate>,
    version: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    let update = {
        let mut held = pending.0.lock().unwrap();
        match held.as_ref() {
            Some(offered) if offered.version == version => held.take().ok_or(SUPERSEDED)?,
            Some(_) => return Err(SUPERSEDED.into()),
            None => return Err(NOTHING_TO_INSTALL.into()),
        }
    };
    let on_chunk = on_progress.clone();
    let mut announced = false;
    let outcome = update
        .download_and_install(
            move |chunk_length, content_length| {
                if !announced {
                    announced = true;
                    let _ = on_chunk.send(DownloadProgress::Started { content_length });
                }
                let _ = on_chunk.send(DownloadProgress::Progress { chunk_length });
            },
            move || {
                let _ = on_progress.send(DownloadProgress::Finished);
            },
        )
        .await
        .map_err(|error| error.to_string());
    if outcome.is_err() {
        let mut held = pending.0.lock().unwrap();
        if held.is_none() {
            *held = Some(update);
        }
    }
    outcome
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn app_update_install(
    _version: String,
    _on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_channel_has_its_own_endpoint() {
        assert_eq!(UpdateChannel::Stable.endpoint(), STABLE_ENDPOINT);
        assert_eq!(UpdateChannel::Rc.endpoint(), RC_ENDPOINT);
        assert_ne!(
            UpdateChannel::Stable.endpoint(),
            UpdateChannel::Rc.endpoint()
        );
    }

    #[test]
    fn the_stable_endpoint_follows_the_latest_release_and_the_rc_one_a_fixed_tag() {
        assert!(STABLE_ENDPOINT.contains("/releases/latest/download/"));
        assert!(RC_ENDPOINT.contains("/releases/download/rc/"));
    }

    #[test]
    fn a_channel_is_named_in_lowercase_over_the_wire() {
        assert_eq!(
            serde_json::from_str::<UpdateChannel>("\"rc\"").unwrap(),
            UpdateChannel::Rc
        );
        assert_eq!(
            serde_json::from_str::<UpdateChannel>("\"stable\"").unwrap(),
            UpdateChannel::Stable
        );
        assert!(serde_json::from_str::<UpdateChannel>("\"nightly\"").is_err());
    }

    #[test]
    fn progress_matches_the_updater_plugin_event_shape() {
        let started = serde_json::to_value(DownloadProgress::Started {
            content_length: Some(10),
        })
        .unwrap();
        assert_eq!(started["event"], "Started");
        assert_eq!(started["data"]["contentLength"], 10);
        let progress =
            serde_json::to_value(DownloadProgress::Progress { chunk_length: 4 }).unwrap();
        assert_eq!(progress["event"], "Progress");
        assert_eq!(progress["data"]["chunkLength"], 4);
        assert_eq!(
            serde_json::to_value(DownloadProgress::Finished).unwrap()["event"],
            "Finished"
        );
    }
}
