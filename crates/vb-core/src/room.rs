//! Convite curto e criptografia da sala.
//!
//! `VB3.<segredo 22 chars>[.<relay em base64url, só se não for o padrão>]`
//!
//! O segredo (128 bits) nunca vai ao relay: dele derivam o nome do tópico (hash) e a chave
//! AES-256-GCM (HKDF). Mudanças em relação ao VB2 do app em Electron:
//!  * o tópico entra como *dado autenticado adicional* (AAD): uma mensagem copiada para outro tópico não abre;
//!  * o texto é comprimido (deflate) antes de cifrar quando compensa. Um SDP de ~4 KB costuma caber numa
//!    única mensagem do relay em vez de 2-3 (menos requisições, menos chance de bater no limite de taxa).
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const DEFAULT_RELAY: &str = "https://ntfy.sh";
pub const CODE_PREFIX: &str = "VB3.";
const SECRET_LEN: usize = 22;
const COMPRESS_MIN: usize = 200;
const MAX_PLAINTEXT: u64 = 1 << 20; // proteção contra "bomba de descompressão"

#[derive(Debug, thiserror::Error)]
pub enum RoomError {
    #[error("Segredo inválido.")]
    BadSecret,
    #[error("URL do relay inválida.")]
    BadRelay,
    #[error("Esse código é de uma versão antiga do VideoBridge (VB2). Peça um convite novo.")]
    OldVersion,
    #[error("Código de convite inválido. Ele deve começar com VB3.")]
    BadCode,
    #[error("mensagem inválida ou adulterada")]
    Open,
}

fn is_b64(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-' || c == b'_'
}

pub fn new_secret() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    B64.encode(b)
}

pub fn is_secret(s: &str) -> bool {
    s.len() == SECRET_LEN && s.bytes().all(is_b64)
}

/// `http(s)://host[/caminho]`, sem espaços.
pub fn valid_relay(url: &str) -> bool {
    let rest = match url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        Some(r) => r,
        None => return false,
    };
    !rest.is_empty() && !rest.starts_with('/') && !url.chars().any(char::is_whitespace)
}

pub fn make_code(secret: &str, relay: &str) -> Result<String, RoomError> {
    if !is_secret(secret) {
        return Err(RoomError::BadSecret);
    }
    let base = relay.trim_end_matches('/');
    if !valid_relay(base) {
        return Err(RoomError::BadRelay);
    }
    Ok(if base == DEFAULT_RELAY {
        format!("{CODE_PREFIX}{secret}")
    } else {
        format!("{CODE_PREFIX}{secret}.{}", B64.encode(base))
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParsedCode {
    pub secret: String,
    pub relay: Option<String>,
}

/// Aceita o código puro, `videobridge://join/…`, a URL da página-ponte (`…#código`), crases e texto em volta.
pub fn parse_code(text: &str) -> Result<ParsedCode, RoomError> {
    let Some(i) = text.find(CODE_PREFIX) else {
        return Err(if text.contains("VB2.") { RoomError::OldVersion } else { RoomError::BadCode });
    };
    let rest = &text[i + CODE_PREFIX.len()..];
    let secret: String = rest.chars().take(SECRET_LEN).collect();
    if !is_secret(&secret) {
        return Err(RoomError::BadCode);
    }
    let after = &rest[SECRET_LEN..];
    let relay = after.strip_prefix('.').and_then(|r| {
        let enc: String = r.bytes().take_while(|c| is_b64(*c)).map(char::from).collect();
        let dec = B64.decode(enc).ok()?;
        let s = String::from_utf8(dec).ok()?;
        valid_relay(&s).then_some(s)
    });
    Ok(ParsedCode { secret, relay })
}

/// Tópico e chave derivados do segredo.
#[derive(Clone)]
pub struct RoomKeys {
    pub topic: String,
    key: [u8; 32],
}

impl RoomKeys {
    pub fn new(secret: &str) -> Self {
        let h = Sha256::digest(format!("topic:{secret}").as_bytes());
        let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
        let topic = format!("vb{}", &hex[..40]);
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(b"videobridge-v3"), secret.as_bytes())
            .expand(b"room-key", &mut key)
            .expect("32 bytes é um tamanho válido para o HKDF-SHA256");
        Self { topic, key }
    }

    /// JSON → [flag][dados] → AES-256-GCM(AAD = tópico) → base64url(nonce ‖ cifrado ‖ tag).
    pub fn seal(&self, v: &Value) -> String {
        let raw = serde_json::to_vec(v).expect("serde_json::Value sempre serializa");
        let mut plain = vec![0u8];
        let mut packed = false;
        if raw.len() >= COMPRESS_MIN {
            let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
            if enc.write_all(&raw).is_ok() {
                if let Ok(c) = enc.finish() {
                    if c.len() < raw.len() {
                        plain[0] = 1;
                        plain.extend_from_slice(&c);
                        packed = true;
                    }
                }
            }
        }
        if !packed {
            plain.extend_from_slice(&raw);
        }
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = Aes256Gcm::new_from_slice(&self.key)
            .expect("chave de 32 bytes")
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: self.topic.as_bytes() })
            .expect("AES-GCM não falha ao cifrar");
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        B64.encode(out)
    }

    pub fn open(&self, text: &str) -> Result<Value, RoomError> {
        let buf = B64.decode(text.trim()).map_err(|_| RoomError::Open)?;
        if buf.len() < 12 + 16 + 2 {
            return Err(RoomError::Open);
        }
        let plain = Aes256Gcm::new_from_slice(&self.key)
            .expect("chave de 32 bytes")
            .decrypt(Nonce::from_slice(&buf[..12]), Payload { msg: &buf[12..], aad: self.topic.as_bytes() })
            .map_err(|_| RoomError::Open)?;
        let (flag, data) = plain.split_first().ok_or(RoomError::Open)?;
        let json = match flag {
            0 => data.to_vec(),
            1 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(data)
                    .take(MAX_PLAINTEXT + 1)
                    .read_to_end(&mut out)
                    .map_err(|_| RoomError::Open)?;
                if out.len() as u64 > MAX_PLAINTEXT {
                    return Err(RoomError::Open);
                }
                out
            }
            _ => return Err(RoomError::Open),
        };
        serde_json::from_slice(&json).map_err(|_| RoomError::Open)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn secret_has_22_chars() {
        for _ in 0..50 {
            assert!(is_secret(&new_secret()));
        }
    }

    #[test]
    fn code_roundtrip_default_and_custom_relay() {
        let s = new_secret();
        let c = make_code(&s, DEFAULT_RELAY).unwrap();
        assert_eq!(c, format!("VB3.{s}"));
        assert_eq!(parse_code(&c).unwrap(), ParsedCode { secret: s.clone(), relay: None });
        let c = make_code(&s, "https://ntfy.exemplo.com/sub/").unwrap();
        let p = parse_code(&format!("entra aí: `{c}` valeu")).unwrap();
        assert_eq!(p.secret, s);
        assert_eq!(p.relay.as_deref(), Some("https://ntfy.exemplo.com/sub"));
    }

    #[test]
    fn parse_accepts_links_and_rejects_garbage() {
        let s = new_secret();
        assert!(parse_code(&format!("videobridge://join/VB3.{s}")).is_ok());
        assert!(parse_code(&format!("https://x.github.io/join/#VB3.{s}")).is_ok());
        assert!(matches!(parse_code("VB3.curto"), Err(RoomError::BadCode)));
        assert!(matches!(parse_code("abc"), Err(RoomError::BadCode)));
        assert!(matches!(parse_code(&format!("VB2.{s}")), Err(RoomError::OldVersion)));
        assert!(make_code("curto", DEFAULT_RELAY).is_err());
        assert!(make_code(&s, "ftp://x").is_err());
    }

    #[test]
    fn seal_open_roundtrip_small_and_compressed() {
        let k = RoomKeys::new(&new_secret());
        let small = json!({"t":"hello","name":"Ana"});
        assert_eq!(k.open(&k.seal(&small)).unwrap(), small);
        let sdp = "a=candidate:1 1 udp 2113937151 192.168.0.10 50000 typ host\r\n".repeat(60);
        let big = json!({"t":"desc","desc":{"sdp":sdp}});
        let sealed = k.seal(&big);
        assert_eq!(k.open(&sealed).unwrap(), big);
        assert!(sealed.len() < serde_json::to_vec(&big).unwrap().len() / 2, "SDP repetitivo deve comprimir bem");
    }

    #[test]
    fn tampered_or_foreign_messages_are_rejected() {
        let a = RoomKeys::new(&new_secret());
        let b = RoomKeys::new(&new_secret());
        let m = a.seal(&json!({"t":"x"}));
        assert!(b.open(&m).is_err(), "outra sala");
        let mut bytes = B64.decode(&m).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(a.open(&B64.encode(bytes)).is_err(), "adulterada");
        assert!(a.open("lixo!!").is_err());
    }

    #[test]
    fn topic_is_bound_as_aad() {
        let s = new_secret();
        let a = RoomKeys::new(&s);
        let mut other = RoomKeys::new(&s);
        other.topic = "vboutrotopico".into(); // mesma chave, tópico diferente
        assert!(other.open(&a.seal(&json!({"t":"x"}))).is_err());
    }

    #[test]
    fn topic_is_stable_and_not_the_secret() {
        let s = new_secret();
        let t = RoomKeys::new(&s).topic;
        assert_eq!(t, RoomKeys::new(&s).topic);
        assert_eq!(t.len(), 42);
        assert!(!t.contains(&s));
    }
}
