use std::fmt;

use super::{bridge::Diagnostics, pool::LinkFailure};

const WSL_SERVICE_FAILURE: i32 = -1;
const WSL_ERROR_CODE: &str = "Error code: ";
const WSL_RELAY_PREFIX: &str = "<3>WSL (";
const WSL_RELAY_ERROR: &str = ") ERROR: ";
const WSL_LAUNCH_FAILURE: &str = "execvpe(";

#[derive(Debug, PartialEq, Eq)]
pub struct BridgeExit {
    pub code: Option<i32>,
    pub stderr: String,
    pub stdout: String,
    pub diagnostics: Diagnostics,
}

impl BridgeExit {
    pub fn new(code: Option<i32>, stderr: &[u8], stdout: &[u8], diagnostics: Diagnostics) -> Self {
        let decode: fn(&[u8]) -> String = match diagnostics {
            Diagnostics::Plain => decode_utf8,
            Diagnostics::Wsl => decode_wsl_output,
        };
        Self {
            code,
            stderr: decode(stderr),
            stdout: decode(stdout),
            diagnostics,
        }
    }

    pub fn is_permanent(&self) -> bool {
        matches!(self.code, Some(2..=4 | 126 | 127)) || self.wsl_failure().is_some()
    }

    fn wsl_failure(&self) -> Option<String> {
        if self.diagnostics != Diagnostics::Wsl || self.code == Some(0) {
            return None;
        }
        let service_failed = self.code == Some(WSL_SERVICE_FAILURE);
        service_failed
            .then(|| service_error(&self.stdout))
            .flatten()
            .or_else(|| launch_failure(&self.stderr))
            .or_else(|| {
                service_failed.then(|| {
                    format!(
                        "wsl.exe exited with code {:#010x}",
                        WSL_SERVICE_FAILURE as u32
                    )
                })
            })
    }
}

fn service_error(stdout: &str) -> Option<String> {
    let lines: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let code = lines
        .iter()
        .find_map(|line| line.strip_prefix(WSL_ERROR_CODE));
    let explanation = lines
        .iter()
        .filter(|line| !line.starts_with(WSL_ERROR_CODE))
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    match (explanation.is_empty(), code) {
        (true, None) => None,
        (true, Some(code)) => Some(code.to_string()),
        (false, None) => Some(explanation),
        (false, Some(code)) => Some(format!("{explanation} ({code})")),
    }
}

fn launch_failure(stderr: &str) -> Option<String> {
    stderr.lines().rev().find_map(|line| {
        let (_, message) = line
            .trim()
            .strip_prefix(WSL_RELAY_PREFIX)?
            .split_once(WSL_RELAY_ERROR)?;
        let message = without_source_location(message);
        message
            .starts_with(WSL_LAUNCH_FAILURE)
            .then(|| message.to_string())
    })
}

fn without_source_location(message: &str) -> &str {
    let Some((location, rest)) = message.split_once(": ") else {
        return message;
    };
    let is_location = location.split_once(':').is_some_and(|(function, line)| {
        !function.is_empty()
            && function
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            && !line.is_empty()
            && line.bytes().all(|byte| byte.is_ascii_digit())
    });
    if is_location {
        rest
    } else {
        message
    }
}

impl fmt::Display for BridgeExit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(failure) = self.wsl_failure() {
            return write!(formatter, "WSL could not start the bridge: {failure}");
        }
        match self.code {
            Some(code) => write!(formatter, "the bridge exited with code {code}")?,
            None => formatter.write_str("the bridge was terminated")?,
        }
        match self
            .stderr
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
        {
            Some(line) => write!(formatter, ": {line}"),
            None => Ok(()),
        }
    }
}

impl From<BridgeExit> for LinkFailure {
    fn from(exit: BridgeExit) -> Self {
        Self {
            permanent: exit.is_permanent(),
            message: exit.to_string(),
        }
    }
}

fn decode_utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    let Some(start) = utf16le_start(bytes) else {
        return decode_utf8(bytes);
    };
    let units: Vec<u16> = bytes[start..]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn utf16le_start(bytes: &[u8]) -> Option<usize> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(2);
    }
    let pairs = bytes.len() / 2;
    let mostly_zero_from = |offset: usize| {
        pairs > 0
            && bytes
                .iter()
                .skip(offset)
                .step_by(2)
                .filter(|byte| **byte == 0)
                .count()
                * 2
                > pairs
    };
    if mostly_zero_from(1) {
        Some(0)
    } else if mostly_zero_from(0) {
        Some(1)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MISSING_DISTRO: &str = "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n";
    const MISSING_USER_RELAY: &str = "<3>WSL (439 - Relay) ERROR: CreateProcessParseCommon:1006: getpwnam(nosuchuser) failed 0\n";
    const MISSING_PROGRAM_RELAY: &str = "<3>WSL (442 - Relay) ERROR: CreateProcessCommon:818: execvpe(nosuchprog) failed: No such file or directory\n";
    const CHDIR_WARNING_RELAY: &str = "<3>WSL (35 - Relay) ERROR: CreateProcessEntryCommon:559: chdir(/mnt/c/Program Files/choux) failed 2\n";

    fn wsl(code: i32, stderr: &str, stdout: &str) -> BridgeExit {
        BridgeExit::new(
            Some(code),
            stderr.as_bytes(),
            stdout.as_bytes(),
            Diagnostics::Wsl,
        )
    }

    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn names_a_missing_distribution() {
        let exit = wsl(-1, "", MISSING_DISTRO);

        assert!(exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "WSL could not start the bridge: There is no distribution with the supplied name. (Wsl/Service/WSL_E_DISTRO_NOT_FOUND)"
        );
    }

    #[test]
    fn reads_the_utf16_output_of_a_wsl_that_ignores_wsl_utf8() {
        let exit = BridgeExit::new(Some(-1), &[], &utf16le(MISSING_DISTRO), Diagnostics::Wsl);

        assert_eq!(exit.to_string(), wsl(-1, "", MISSING_DISTRO).to_string());
    }

    #[test]
    fn realigns_utf16_that_starts_inside_a_character() {
        let bytes = utf16le("<3>WSL (1 - Relay) ERROR: failed");

        assert_eq!(
            decode_wsl_output(&bytes[1..]),
            "3>WSL (1 - Relay) ERROR: failed"
        );
    }

    #[test]
    fn leaves_utf8_output_alone() {
        assert_eq!(
            decode_wsl_output("zażółć ‘ptys’".as_bytes()),
            "zażółć ‘ptys’"
        );
    }

    #[test]
    fn prefers_the_service_message_to_the_relay_line_for_a_missing_user() {
        let exit = wsl(
            -1,
            MISSING_USER_RELAY,
            "User not found.\r\nError code: Wsl/WSL_E_USER_NOT_FOUND\r\n",
        );

        assert!(exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "WSL could not start the bridge: User not found. (Wsl/WSL_E_USER_NOT_FOUND)"
        );
    }

    #[test]
    fn keeps_a_service_message_that_arrived_without_its_error_code() {
        assert_eq!(
            wsl(-1, "", "User not found.\r\n").to_string(),
            "WSL could not start the bridge: User not found."
        );
    }

    #[test]
    fn strips_the_relay_prefix_and_source_location_of_a_launch_failure() {
        let exit = wsl(1, MISSING_PROGRAM_RELAY, "");

        assert!(exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "WSL could not start the bridge: execvpe(nosuchprog) failed: No such file or directory"
        );
    }

    #[test]
    fn a_relay_warning_the_command_ran_past_is_not_a_launch_failure() {
        let exit = wsl(
            1,
            &format!("{CHDIR_WARNING_RELAY}ptys bridge: the socket closed mid-request\n"),
            "",
        );
        let failure = LinkFailure::from(exit);

        assert!(!failure.permanent);
        assert_eq!(
            failure.message,
            "the bridge exited with code 1: ptys bridge: the socket closed mid-request"
        );
        assert!(!wsl(1, CHDIR_WARNING_RELAY, "").is_permanent());
        assert!(
            !BridgeExit::new(None, CHDIR_WARNING_RELAY.as_bytes(), &[], Diagnostics::Wsl)
                .is_permanent()
        );
    }

    #[test]
    fn explains_a_service_failure_that_printed_nothing() {
        let exit = wsl(-1, "", "");

        assert!(exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "WSL could not start the bridge: wsl.exe exited with code 0xffffffff"
        );
    }

    #[test]
    fn a_missing_program_is_permanent_for_every_bridge() {
        for diagnostics in [Diagnostics::Plain, Diagnostics::Wsl] {
            let exit = BridgeExit::new(
                Some(127),
                "env: ‘ptys’: No such file or directory\n".as_bytes(),
                &[],
                diagnostics,
            );

            assert!(exit.is_permanent(), "{diagnostics:?}");
            assert_eq!(
                exit.to_string(),
                "the bridge exited with code 127: env: ‘ptys’: No such file or directory"
            );
        }
    }

    #[test]
    fn a_plain_bridge_ignores_wsl_markers() {
        let exit = BridgeExit::new(
            Some(1),
            MISSING_PROGRAM_RELAY.as_bytes(),
            MISSING_DISTRO.as_bytes(),
            Diagnostics::Plain,
        );

        assert!(!exit.is_permanent());
        assert!(exit
            .to_string()
            .starts_with("the bridge exited with code 1: <3>WSL"));
    }

    #[test]
    fn session_output_that_mentions_a_wsl_error_is_not_a_wsl_failure() {
        let exit = wsl(1, "ptys bridge: stdout failed\n", MISSING_DISTRO);

        assert!(!exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "the bridge exited with code 1: ptys bridge: stdout failed"
        );
    }

    #[test]
    fn a_clean_exit_is_never_a_wsl_failure() {
        let exit = wsl(0, MISSING_PROGRAM_RELAY, MISSING_DISTRO);

        assert!(!exit.is_permanent());
        assert!(exit
            .to_string()
            .starts_with("the bridge exited with code 0"));
    }

    #[test]
    fn keeps_the_existing_message_for_ordinary_exits() {
        let exit = BridgeExit::new(
            Some(3),
            b"first\nptys bridge: no server is running\n\n",
            &[],
            Diagnostics::Plain,
        );

        assert!(exit.is_permanent());
        assert_eq!(
            exit.to_string(),
            "the bridge exited with code 3: ptys bridge: no server is running"
        );
        assert_eq!(
            BridgeExit::new(None, &[], &[], Diagnostics::Plain).to_string(),
            "the bridge was terminated"
        );
    }
}
