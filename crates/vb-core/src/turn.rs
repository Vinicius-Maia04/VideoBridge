//! Servidores TURN opcionais (relay para quando o P2P direto não é possível).
use serde::{Deserialize, Serialize};

pub const MAX_TURN: usize = 5;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct TurnServer {
    pub urls: String,
    pub username: String,
    pub credential: String,
}

fn ok_str(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max && !s.chars().any(|c| c.is_control())
}

fn ok_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    let rest = match l.strip_prefix("turns:").or_else(|| l.strip_prefix("turn:")) {
        Some(r) => r,
        None => return false,
    };
    !rest.is_empty() && u.chars().count() <= 256 && !u.chars().any(|c| c.is_whitespace() || c == '|')
}

/// Valida uma lista (da configuração ou recebida de outro participante).
pub fn sanitize(list: &[TurnServer]) -> Vec<TurnServer> {
    list.iter()
        .filter(|s| ok_url(s.urls.trim()) && ok_str(&s.username, 200) && ok_str(&s.credential, 300))
        .take(MAX_TURN)
        .map(|s| TurnServer { urls: s.urls.trim().to_string(), ..s.clone() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn t(u: &str, n: &str, c: &str) -> TurnServer {
        TurnServer { urls: u.into(), username: n.into(), credential: c.into() }
    }
    #[test]
    fn keeps_valid_drops_invalid_and_caps() {
        let mut v = vec![t("turn:a.com:3478", "u", "p"), t("http://x", "u", "p"), t("turns:b.com:5349", "", "p"), t("turn:c.com", "u\n", "p")];
        assert_eq!(sanitize(&v).len(), 1);
        v = (0..9).map(|i| t(&format!("turn:h{i}.com"), "u", "p")).collect();
        assert_eq!(sanitize(&v).len(), MAX_TURN);
    }
}
