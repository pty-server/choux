use std::{
    env,
    process::{Command, Stdio},
    sync::OnceLock,
};

use crate::shell_var;

const LOCALE_VARS: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];
const UTF8_CODESET: &str = "utf8";

#[cfg(not(target_os = "windows"))]
fn host_locales() -> Vec<String> {
    let Ok(output) = Command::new("locale")
        .arg("-a")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(target_os = "windows")]
fn host_locales() -> Vec<String> {
    Vec::new()
}

fn normalized_codeset(value: &str) -> String {
    value.to_ascii_lowercase().replace(['-', '_'], "")
}

fn split_locale(value: &str) -> (&str, &str) {
    match value.split_once('.') {
        Some((language, codeset)) => (language, codeset),
        None if normalized_codeset(value) == UTF8_CODESET => ("", value),
        None => (value, ""),
    }
}

fn locale_language(value: &str) -> &str {
    split_locale(value).0
}

fn locale_codeset(value: &str) -> String {
    normalized_codeset(split_locale(value).1)
}

fn locale_key(value: &str) -> String {
    format!(
        "{}.{}",
        locale_language(value).to_ascii_lowercase(),
        locale_codeset(value)
    )
}

fn is_utf8_locale(value: &str) -> bool {
    locale_codeset(value) == UTF8_CODESET
}

fn is_language_neutral(value: &str) -> bool {
    locale_language(value).is_empty()
}

fn known_locale(value: &str, host: &[String]) -> bool {
    host.iter()
        .any(|candidate| locale_key(candidate) == locale_key(value))
}

fn resolvable_locale(value: &str, host: &[String]) -> bool {
    is_utf8_locale(value) && known_locale(value, host)
}

fn nearest_utf8_locale(current: &str, host: &[String]) -> Option<String> {
    let utf8: Vec<&String> = host
        .iter()
        .filter(|candidate| is_utf8_locale(candidate))
        .collect();
    let language = locale_language(current);
    utf8.iter()
        .find(|candidate| locale_language(candidate).eq_ignore_ascii_case(language))
        .or_else(|| utf8.iter().find(|candidate| is_language_neutral(candidate)))
        .or(utf8.first())
        .map(|candidate| candidate.to_string())
}

fn locale_env(sources: [Option<&str>; 3], host: &[String]) -> Vec<(&'static str, Option<String>)> {
    let mut vars: Vec<(&'static str, Option<String>)> = LOCALE_VARS
        .iter()
        .zip(sources)
        .filter_map(|(name, value)| value.map(|value| (*name, Some(value.to_string()))))
        .collect();
    let effective = sources.iter().flatten().next().copied().unwrap_or_default();
    if resolvable_locale(effective, host) {
        return vars;
    }
    let Some(replacement) = nearest_utf8_locale(effective, host) else {
        return vars;
    };
    let carries_language = !is_language_neutral(&replacement);

    for (index, name) in LOCALE_VARS.into_iter().enumerate() {
        let current = sources[index];
        let value = match name {
            "LC_CTYPE" => Some(replacement.clone()),
            "LC_ALL" if current.is_none() => None,
            "LC_ALL" => carries_language.then(|| replacement.clone()),
            _ if current.is_some_and(|value| known_locale(value, host)) => {
                current.map(str::to_string)
            }
            _ => carries_language.then(|| replacement.clone()),
        };
        match vars.iter_mut().find(|(existing, _)| *existing == name) {
            Some(entry) => entry.1 = value,
            None if value.is_some() => vars.push((name, value)),
            None => {}
        }
    }
    vars
}

fn locale_source(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| shell_var(name).map(str::to_string))
}

pub(crate) fn user_locale() -> &'static Vec<(&'static str, Option<String>)> {
    static USER_LOCALE: OnceLock<Vec<(&'static str, Option<String>)>> = OnceLock::new();
    USER_LOCALE.get_or_init(|| {
        let host = host_locales();
        let sources = LOCALE_VARS.map(locale_source);
        locale_env(
            [
                sources[0].as_deref(),
                sources[1].as_deref(),
                sources[2].as_deref(),
            ],
            &host,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn macos() -> Vec<String> {
        [
            "C",
            "POSIX",
            "UTF-8",
            "en_US.UTF-8",
            "en_US.ISO8859-1",
            "pl_PL.UTF-8",
        ]
        .map(str::to_string)
        .to_vec()
    }

    fn linux() -> Vec<String> {
        ["C", "C.UTF-8", "POSIX", "en_US.utf8", "pl_PL.utf8"]
            .map(str::to_string)
            .to_vec()
    }

    fn set(vars: &[(&str, Option<String>)], name: &str) -> Option<Option<String>> {
        vars.iter()
            .find(|(existing, _)| *existing == name)
            .map(|(_, value)| value.clone())
    }

    #[test]
    fn keeps_a_locale_the_host_resolves() {
        let vars = locale_env([None, None, Some("C.UTF-8")], &linux());
        assert_eq!(vars, vec![("LANG", Some("C.UTF-8".into()))]);
    }

    #[test]
    fn replaces_a_locale_the_host_cannot_resolve() {
        let vars = locale_env([None, None, Some("C.UTF-8")], &macos());
        assert_eq!(set(&vars, "LC_CTYPE"), Some(Some("UTF-8".into())));
        assert_eq!(set(&vars, "LANG"), Some(None));
    }

    #[test]
    fn fills_in_a_locale_when_the_launch_environment_has_none() {
        let vars = locale_env([None, None, None], &macos());
        assert_eq!(set(&vars, "LC_CTYPE"), Some(Some("UTF-8".into())));
        assert_eq!(set(&vars, "LANG"), None);
    }

    #[test]
    fn keeps_the_language_when_replacing_the_codeset() {
        let vars = locale_env([None, None, Some("pl_PL.ISO8859-2")], &macos());
        assert_eq!(set(&vars, "LC_CTYPE"), Some(Some("pl_PL.UTF-8".into())));
        assert_eq!(set(&vars, "LANG"), Some(Some("pl_PL.UTF-8".into())));
    }

    #[test]
    fn accepts_a_codeset_only_locale() {
        let vars = locale_env([None, Some("UTF-8"), Some("C.UTF-8")], &macos());
        assert_eq!(
            vars,
            vec![
                ("LC_CTYPE", Some("UTF-8".into())),
                ("LANG", Some("C.UTF-8".into())),
            ]
        );
    }

    #[test]
    fn clears_an_lc_all_that_would_outrank_the_replacement() {
        let vars = locale_env([Some("C.UTF-8"), None, Some("C.UTF-8")], &macos());
        assert_eq!(set(&vars, "LC_ALL"), Some(None));
        assert_eq!(set(&vars, "LC_CTYPE"), Some(Some("UTF-8".into())));
    }

    #[test]
    fn never_introduces_an_lc_all_of_its_own() {
        let vars = locale_env([None, None, Some("xx_YY.ISO8859-1")], &macos());
        assert_eq!(set(&vars, "LC_ALL"), None);
        assert_eq!(set(&vars, "LC_CTYPE"), Some(Some("UTF-8".into())));
    }

    #[test]
    fn keeps_a_language_setting_the_host_still_resolves() {
        let vars = locale_env(
            [None, Some("en_US.ISO8859-1"), Some("pl_PL.UTF-8")],
            &macos(),
        );
        assert_eq!(set(&vars, "LC_CTYPE"), Some(Some("en_US.UTF-8".into())));
        assert_eq!(set(&vars, "LANG"), Some(Some("pl_PL.UTF-8".into())));
    }

    #[test]
    fn leaves_the_environment_alone_when_no_locales_are_known() {
        let vars = locale_env([None, None, Some("C.UTF-8")], &[]);
        assert_eq!(vars, vec![("LANG", Some("C.UTF-8".into()))]);
    }
}
