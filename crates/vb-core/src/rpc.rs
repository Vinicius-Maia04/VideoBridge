//! Protocolo do soquete local do Discord (Rich Presence): quadros, comandos e eventos. Só dados puros (testáveis);
//! quem abre o `\\.\pipe\discord-ipc-N` e fala o protocolo é o app (`vb-app/src/rich.rs`).
//!
//! Como o convite "pelo perfil" funciona:
//!  * o app publica uma atividade com `party` (id + tamanho) e `secrets.join` = código da sala;
//!  * o Discord mostra "Entrar" a quem a configuração de privacidade do DONO permitir (amigos e/ou quem está no
//!    mesmo canal de voz) e "Pedir para entrar" aos demais;
//!  * o Discord entrega o segredo ao app de quem entra pelo evento `ACTIVITY_JOIN`.
use crate::room::parse_code;
use serde_json::{json, Value};

pub const OP_HANDSHAKE: u32 = 0;
pub const OP_FRAME: u32 = 1;
pub const OP_CLOSE: u32 = 2;
pub const OP_PING: u32 = 3;
pub const OP_PONG: u32 = 4;
pub const MAX_FRAME: usize = 1 << 20;
/// Limite do Discord para segredos e textos da atividade.
const MAX_FIELD: usize = 128;

/// Agora, em segundos Unix.
pub fn now_unix_for_presence() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// opcode (u32 LE) + tamanho (u32 LE) + JSON.
pub fn encode_frame(op: u32, payload: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(payload).expect("serde_json::Value sempre serializa");
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

pub fn parse_header(h: &[u8; 8]) -> (u32, usize) {
    (u32::from_le_bytes([h[0], h[1], h[2], h[3]]), u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize)
}

pub fn handshake(app_id: &str) -> Value {
    json!({ "v": 1, "client_id": app_id })
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoomPresence {
    /// Código de convite (`VB3.…`): vira o segredo de entrada.
    pub code: String,
    pub party_id: String,
    pub people: u32,
    pub max: u32,
    pub sources: Vec<String>,
    /// Instante (Unix, s) em que a sala começou; o Discord mostra "há X minutos".
    pub started: u64,
}

fn clean(s: &str, max: usize) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect();
    if t.chars().count() <= max { t } else { format!("{}…", t.chars().take(max - 1).collect::<String>()) }
}

/// Só vira segredo de entrada um código válido que caiba no limite do Discord.
pub fn join_secret_ok(s: &str) -> bool {
    s.len() <= MAX_FIELD && parse_code(s).is_ok()
}

pub fn activity(p: &RoomPresence) -> Value {
    let details = if p.sources.is_empty() { "Sala aberta".to_string() } else { format!("Transmitindo: {}", p.sources.iter().take(2).cloned().collect::<Vec<_>>().join(" · ")) };
    let cur = p.people.max(1);
    let max = p.max.max(cur);
    let mut a = json!({
        "details": clean(&details, MAX_FIELD),
        "state": format!("{} na sala", cur),
        "timestamps": { "start": p.started },
        // `party.id` é obrigatório: sem ele o Discord não mostra "Pedir para entrar"
        "party": { "id": p.party_id, "size": [cur, max] },
        "instance": true,
        // imagem enviada em "Rich Presence → Art Assets" no portal de desenvolvedores, com a chave `logo`
        "assets": { "large_image": "logo", "large_text": "VideoBridge" },
    });
    if join_secret_ok(&p.code) {
        a["secrets"] = json!({ "join": p.code });
    }
    a
}

/// `p = None` limpa a atividade.
pub fn set_activity(pid: u32, p: Option<&RoomPresence>, nonce: &str) -> Value {
    json!({ "cmd": "SET_ACTIVITY", "args": { "pid": pid, "activity": p.map(activity) }, "nonce": nonce })
}

pub fn subscribe(evt: &str, nonce: &str) -> Value {
    json!({ "cmd": "SUBSCRIBE", "evt": evt, "nonce": nonce })
}

/// Recusa um "Pedir para entrar" (quem não está no canal de voz).
pub fn reject_request(user_id: &str, nonce: &str) -> Value {
    json!({ "cmd": "CLOSE_ACTIVITY_JOIN_REQUEST", "args": { "user_id": user_id }, "nonce": nonce })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    Ready,
    /// Alguém (ou eu) entrou pelo perfil: o segredo é o código da sala.
    Join(String),
    JoinRequest(String),
    Error { code: i64, message: String },
    Other,
}

pub fn parse_incoming(v: &Value) -> Incoming {
    match (v["evt"].as_str(), v["cmd"].as_str()) {
        (Some("READY"), _) => Incoming::Ready,
        (Some("ACTIVITY_JOIN"), _) => v["data"]["secret"].as_str().map(|s| Incoming::Join(s.to_string())).unwrap_or(Incoming::Other),
        (Some("ACTIVITY_JOIN_REQUEST"), _) => v["data"]["user"]["id"].as_str().map(|s| Incoming::JoinRequest(s.to_string())).unwrap_or(Incoming::Other),
        (Some("ERROR"), _) => Incoming::Error { code: v["data"]["code"].as_i64().unwrap_or(0), message: v["data"]["message"].as_str().unwrap_or("").to_string() },
        _ => Incoming::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room::{make_code, new_secret, party_id, DEFAULT_RELAY};

    fn presence() -> RoomPresence {
        let s = new_secret();
        RoomPresence { code: make_code(&s, DEFAULT_RELAY).unwrap(), party_id: party_id(&s), people: 2, max: 6, sources: vec![], started: 1_700_000_000 }
    }

    #[test]
    fn frame_roundtrip() {
        let f = encode_frame(OP_FRAME, &json!({"a": 1}));
        let h: [u8; 8] = f[..8].try_into().unwrap();
        let (op, len) = parse_header(&h);
        assert_eq!((op, len), (OP_FRAME, f.len() - 8));
        assert_eq!(serde_json::from_slice::<Value>(&f[8..]).unwrap(), json!({"a": 1}));
    }

    #[test]
    fn handshake_shape() {
        assert_eq!(handshake("123"), json!({"v": 1, "client_id": "123"}));
    }

    #[test]
    fn activity_has_party_join_secret_and_sizes() {
        let p = presence();
        let a = activity(&p);
        assert_eq!(a["details"], "Sala aberta");
        assert_eq!(a["state"], "2 na sala");
        assert_eq!(a["party"]["size"], json!([2, 6]));
        assert_eq!(a["party"]["id"], p.party_id);
        assert_eq!(a["secrets"]["join"], p.code);
        assert_eq!(a["instance"], true);
        assert_eq!(a["assets"]["large_image"], "logo");
    }

    #[test]
    fn activity_lists_sources_and_clamps_sizes() {
        let mut p = presence();
        p.sources = vec!["Ana: 🖥 Jogo".into(), "Bia: 📷 Câmera".into(), "Cris: 🖥 X".into()];
        p.people = 0;
        p.max = 0;
        let a = activity(&p);
        assert_eq!(a["details"], "Transmitindo: Ana: 🖥 Jogo · Bia: 📷 Câmera");
        assert_eq!(a["party"]["size"], json!([1, 1]), "nunca 0 pessoas nem máximo menor que o atual");
    }

    #[test]
    fn invalid_or_oversized_codes_are_never_published_as_secrets() {
        let mut p = presence();
        p.code = "isto não é um convite".into();
        assert!(activity(&p).get("secrets").is_none());
        let s = new_secret();
        p.code = make_code(&s, &format!("https://{}.example.com", "a".repeat(120))).unwrap();
        assert!(p.code.len() > 128 && activity(&p).get("secrets").is_none(), "passa do limite de 128 do Discord");
    }

    #[test]
    fn texts_are_cleaned_and_truncated() {
        let mut p = presence();
        p.sources = vec![format!("A\n{}", "x".repeat(400))];
        let d = activity(&p)["details"].as_str().unwrap().to_string();
        assert!(d.chars().count() <= 128 && !d.contains('\n') && d.ends_with('…'));
    }

    #[test]
    fn set_activity_and_clear() {
        let c = set_activity(77, Some(&presence()), "n1");
        assert_eq!(c["cmd"], "SET_ACTIVITY");
        assert_eq!(c["args"]["pid"], 77);
        assert!(c["args"]["activity"].is_object());
        assert!(set_activity(77, None, "n2")["args"]["activity"].is_null(), "null limpa a atividade");
    }

    #[test]
    fn incoming_events() {
        assert_eq!(parse_incoming(&json!({"cmd":"DISPATCH","evt":"READY","data":{}})), Incoming::Ready);
        assert_eq!(parse_incoming(&json!({"cmd":"DISPATCH","evt":"ACTIVITY_JOIN","data":{"secret":"VB3.x"}})), Incoming::Join("VB3.x".into()));
        assert_eq!(parse_incoming(&json!({"evt":"ACTIVITY_JOIN_REQUEST","data":{"user":{"id":"42","username":"z"}}})), Incoming::JoinRequest("42".into()));
        assert_eq!(parse_incoming(&json!({"evt":"ERROR","data":{"code":4000,"message":"ruim"}})), Incoming::Error { code: 4000, message: "ruim".into() });
        assert_eq!(parse_incoming(&json!({"cmd":"SET_ACTIVITY","data":{}})), Incoming::Other);
        assert_eq!(parse_incoming(&json!({"evt":"ACTIVITY_JOIN","data":{}})), Incoming::Other);
    }
}
