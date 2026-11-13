//! Quem está na sala, visto só pelas mensagens do relay (sem WebRTC).
//! Serve para o "vigia" do aviso do Discord: depois que o dono sai da sala, o app dele continua ouvindo o relay
//! e só apaga a mensagem quando o ÚLTIMO participante sair (`bye`/`closed`) ou sumir (sem sinal de vida).
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Sem nenhuma mensagem de um participante por este tempo, ele é dado como saído (cai da rede, fecha à força).
/// Quando o dono vigia o aviso do Discord (`g` no hello), os participantes mandam um `hb` (batimento) a cada 2 min.
pub const TTL: Duration = Duration::from_secs(330);

#[derive(Debug, Clone)]
struct Member {
    name: String,
    src: Vec<String>,
    seen: Instant,
}

#[derive(Debug, Default)]
pub struct Presence {
    members: HashMap<String, Member>,
    closed: bool,
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

fn valid_id(s: &str) -> bool {
    (6..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

impl Presence {
    /// Atualiza com uma mensagem da sala (já decifrada e sem o eco próprio).
    pub fn on_message(&mut self, m: &Value, now: Instant) {
        let (Some(t), Some(r)) = (m["t"].as_str(), m["r"].as_str()) else { return };
        if !valid_id(r) {
            return;
        }
        match t {
            "bye" => { self.members.remove(r); }
            "closed" => { self.members.remove(r); self.closed = true; }
            _ => {
                let e = self.members.entry(r.to_string()).or_insert_with(|| Member { name: "Alguém".into(), src: vec![], seen: now });
                e.seen = now;
                if t == "hello" || t == "hb" {
                    if let Some(n) = m["name"].as_str().filter(|n| !n.trim().is_empty()) {
                        e.name = clean(n, 40);
                    }
                }
                if t == "hb" {
                    e.src = m["src"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| clean(x, 120)).filter(|x| !x.is_empty()).take(6).collect()).unwrap_or_default();
                }
            }
        }
    }

    /// A sala foi encerrada explicitamente (alguém saiu sozinho e mandou `closed`).
    pub fn is_closed(&self) -> bool { self.closed }

    /// (quantas pessoas, linhas "Nome: fonte" ordenadas) considerando só quem deu sinal dentro do `ttl`.
    pub fn snapshot(&self, now: Instant, ttl: Duration) -> (u32, Vec<String>) {
        let mut alive: Vec<&Member> = self.members.values().filter(|m| now.duration_since(m.seen) <= ttl).collect();
        alive.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        let lines = alive.iter().flat_map(|m| m.src.iter().map(move |s| format!("{}: {}", m.name, s))).collect();
        (alive.len() as u32, lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const A: &str = "peerAAAA1";
    const B: &str = "peerBBBB2";

    #[test]
    fn hello_and_heartbeat_track_people_and_sources() {
        let (mut p, t0) = (Presence::default(), Instant::now());
        p.on_message(&json!({"t":"hello","r":A,"name":"Ana"}), t0);
        p.on_message(&json!({"t":"hb","r":B,"name":"Bia","src":["🖥 Jogo + 🔊"]}), t0);
        let (n, lines) = p.snapshot(t0, TTL);
        assert_eq!(n, 2);
        assert_eq!(lines, vec!["Bia: 🖥 Jogo + 🔊".to_string()]);
    }

    #[test]
    fn bye_removes_and_closed_ends_the_room() {
        let (mut p, t0) = (Presence::default(), Instant::now());
        p.on_message(&json!({"t":"hello","r":A,"name":"Ana"}), t0);
        p.on_message(&json!({"t":"hello","r":B,"name":"Bia"}), t0);
        p.on_message(&json!({"t":"bye","r":A}), t0);
        assert_eq!(p.snapshot(t0, TTL).0, 1);
        assert!(!p.is_closed());
        p.on_message(&json!({"t":"closed","r":B}), t0);
        assert!(p.is_closed());
        assert_eq!(p.snapshot(t0, TTL).0, 0);
    }

    #[test]
    fn silent_members_expire_and_any_message_refreshes() {
        let (mut p, t0) = (Presence::default(), Instant::now());
        p.on_message(&json!({"t":"hello","r":A,"name":"Ana"}), t0);
        assert_eq!(p.snapshot(t0 + TTL + Duration::from_secs(1), TTL).0, 0);
        p.on_message(&json!({"t":"desc","r":A}), t0 + Duration::from_secs(100));
        assert_eq!(p.snapshot(t0 + Duration::from_secs(200), TTL).0, 1);
    }

    #[test]
    fn junk_is_ignored_and_text_is_sanitized() {
        let (mut p, t0) = (Presence::default(), Instant::now());
        p.on_message(&json!({"t":"hello","r":"x","name":"curto"}), t0); // id inválido
        p.on_message(&json!({"t":"hello"}), t0);
        p.on_message(&json!("texto"), t0);
        assert_eq!(p.snapshot(t0, TTL).0, 0);
        p.on_message(&json!({"t":"hb","r":A,"name":"A\nna","src":["x".repeat(500), "", "ok"]}), t0);
        let (_, lines) = p.snapshot(t0, TTL);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("Ana: ") && lines[0].chars().count() <= 5 + 120);
    }
}
