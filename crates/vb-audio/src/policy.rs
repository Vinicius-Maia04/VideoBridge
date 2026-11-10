//! Quais aplicativos entram na transmissão.
use serde_json::Value;
use std::collections::HashSet;
use vb_core::config::normalize_exe_list;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    /// Aplicativos que abrirem depois entram transmitindo?
    pub allow_new: bool,
    pub blocked: HashSet<String>,
    pub allowed: HashSet<String>,
}

impl Policy {
    /// Aceita o objeto `{ allowNew, blocked, allowed }` do renderer (e ignora o resto).
    pub fn from_json(v: &Value) -> Self {
        let list = |k: &str| -> HashSet<String> {
            let raw: Vec<String> = v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            normalize_exe_list(&raw).into_iter().collect()
        };
        Self { allow_new: v.get("allowNew").and_then(Value::as_bool).unwrap_or(true), blocked: list("blocked"), allowed: list("allowed") }
    }

    pub fn included(&self, key: &str) -> bool {
        let k = key.to_lowercase();
        !self.blocked.contains(&k) && (self.allowed.contains(&k) || self.allow_new)
    }

    /// "Tudo, menos o VideoBridge" cabe numa captura só (modo EXCLUDE do Windows): um fluxo, uma thread,
    /// e aplicativos novos entram no mesmo instante em que abrem (sem esperar a próxima varredura).
    /// Qualquer bloqueio individual exige o modo por aplicativo.
    pub fn exclude_self_mode(&self) -> bool {
        self.allow_new && self.blocked.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_to_allow_new() {
        let p = Policy::from_json(&json!({}));
        assert!(p.allow_new && p.included("qualquer.exe") && p.exclude_self_mode());
    }
    #[test]
    fn blocked_wins_and_is_case_insensitive() {
        let p = Policy::from_json(&json!({"allowNew": true, "blocked": ["Chrome.exe"], "allowed": ["chrome.exe"]}));
        assert!(!p.included("CHROME.EXE") && p.included("spotify.exe") && !p.exclude_self_mode());
    }
    #[test]
    fn without_allow_new_only_allowed_enter() {
        let p = Policy::from_json(&json!({"allowNew": false, "allowed": ["spotify.exe"]}));
        assert!(p.included("Spotify.exe") && !p.included("chrome.exe") && !p.exclude_self_mode());
    }
    #[test]
    fn junk_names_are_dropped() {
        let p = Policy::from_json(&json!({"blocked": ["a|b", "ok.exe", 5, "..\\x"]}));
        assert_eq!(p.blocked.len(), 1);
    }
}
