//! Configuração local em `config.json`. Sem banco remoto.
//!
//! A leitura é tolerante como a do app em Electron: campo ausente ou com tipo errado volta ao padrão
//! (o arquivo inteiro nunca é descartado por causa de um campo).
use crate::room::valid_relay;
use crate::turn::{self, TurnServer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Mic {
    pub enabled: bool,
    pub device_id: String,
    pub gain: f64,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Webcam {
    pub enabled: bool,
    pub device_id: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Signaling {
    pub relay: String,
    pub max_participants: u32,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Sfx {
    pub enabled: bool,
    pub volume: f64,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppAudioCfg {
    pub enabled: bool,
    pub allow_new: bool,
    pub blocked: Vec<String>,
    pub allowed: Vec<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscordCfg {
    pub announce: bool,
    pub webhook_url: String,
    pub join_page_url: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub toggle_stream: String,
    pub toggle_camera: String,
    pub toggle_mic: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub host_name: String,
    pub resolution: u32,
    pub fps: u32,
    /// `"auto"` ou kbps (número) — o renderer manda os dois formatos.
    pub bitrate: Value,
    pub codec: String,
    pub priority: String,
    pub system_audio: bool,
    pub system_audio_device: String,
    pub mic: Mic,
    pub webcam: Webcam,
    pub stun: Vec<String>,
    pub turn: Vec<TurnServer>,
    pub share_turn: bool,
    pub signaling: Signaling,
    pub preview: bool,
    pub sfx: Sfx,
    pub app_audio: AppAudioCfg,
    pub discord: DiscordCfg,
    pub hotkeys: Hotkeys,
    pub autostart: bool,
    pub start_minimized: bool,
}

impl Default for Mic { fn default() -> Self { Self { enabled: false, device_id: String::new(), gain: 1.0 } } }
impl Default for Webcam { fn default() -> Self { Self { enabled: false, device_id: String::new() } } }
impl Default for Signaling { fn default() -> Self { Self { relay: crate::room::DEFAULT_RELAY.into(), max_participants: 6 } } }
impl Default for Sfx { fn default() -> Self { Self { enabled: true, volume: 0.5 } } }
impl Default for AppAudioCfg { fn default() -> Self { Self { enabled: true, allow_new: true, blocked: vec![], allowed: vec![] } } }
impl Default for DiscordCfg { fn default() -> Self { Self { announce: false, webhook_url: String::new(), join_page_url: String::new() } } }
impl Default for Hotkeys {
    fn default() -> Self {
        Self { toggle_stream: "Control+Shift+V".into(), toggle_camera: "Control+Shift+C".into(), toggle_mic: "Control+Shift+M".into() }
    }
}
impl Default for Config {
    fn default() -> Self {
        Self {
            host_name: String::new(),
            resolution: 1080,
            fps: 60,
            bitrate: Value::String("auto".into()),
            codec: "H264".into(),
            priority: "motion".into(),
            system_audio: true,
            system_audio_device: String::new(),
            mic: Mic::default(),
            webcam: Webcam::default(),
            stun: default_stun(),
            turn: vec![],
            share_turn: true,
            signaling: Signaling::default(),
            preview: true,
            sfx: Sfx::default(),
            app_audio: AppAudioCfg::default(),
            discord: DiscordCfg::default(),
            hotkeys: Hotkeys::default(),
            autostart: false,
            start_minimized: false,
        }
    }
}

pub fn default_stun() -> Vec<String> {
    ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478", "stun:global.stun.twilio.com:3478"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Nome de executável: 1..=120 chars, sem controle, `|` nem separadores/curingas de caminho.
pub fn valid_exe_name(s: &str) -> bool {
    let n = s.chars().count();
    (1..=120).contains(&n) && !s.chars().any(|c| c.is_control() || "|\\/:*?\"<>".contains(c))
}

/// Minúsculas, sem repetição, só nomes válidos, no máximo 200.
pub fn normalize_exe_list(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in list {
        let k = x.trim().to_lowercase();
        if valid_exe_name(&k) && !out.contains(&k) {
            out.push(k);
            if out.len() >= 200 {
                break;
            }
        }
    }
    out
}

fn kind(v: &Value) -> u8 {
    match v { Value::Null => 0, Value::Bool(_) => 1, Value::Number(_) => 2, Value::String(_) => 3, Value::Array(_) => 4, Value::Object(_) => 5 }
}

/// Mescla `over` sobre `base`: só aceita campos conhecidos e do mesmo tipo (exceto `bitrate`).
fn merge(base: &Value, over: &Value, key: &str) -> Value {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            let mut out = serde_json::Map::new();
            for (k, bv) in b {
                out.insert(k.clone(), o.get(k).map(|ov| merge(bv, ov, k)).unwrap_or_else(|| bv.clone()));
            }
            Value::Object(out)
        }
        _ if kind(base) == kind(over) || key == "bitrate" => over.clone(),
        _ => base.clone(),
    }
}

fn clamp(v: f64, lo: f64, hi: f64, def: f64) -> f64 {
    if v.is_finite() { v.clamp(lo, hi) } else { def }
}

fn valid_stun(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("stun:").or_else(|| s.strip_prefix("stuns:")) else { return false };
    let (host, port) = match rest.split_once(':') { Some((h, p)) => (h, Some(p)), None => (rest, None) };
    !host.is_empty()
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        && port.map_or(true, |p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn sanitize(raw: &Value) -> Config {
    let defaults = serde_json::to_value(Config::default()).expect("Config serializa");
    let merged = merge(&defaults, raw, "");
    let mut c: Config = serde_json::from_value(merged).unwrap_or_default();
    let d = Config::default();
    if ![360, 480, 720, 1080, 1440].contains(&c.resolution) { c.resolution = d.resolution; }
    if ![15, 30, 60].contains(&c.fps) { c.fps = d.fps; }
    c.bitrate = match &c.bitrate {
        Value::Number(n) => match n.as_f64() {
            Some(x) if (300.0..=20000.0).contains(&x) => Value::from(x.round() as u32),
            _ => Value::from("auto"),
        },
        Value::String(s) if s != "auto" => match s.parse::<f64>() {
            Ok(x) if (300.0..=20000.0).contains(&x) => Value::from(x.round() as u32),
            _ => Value::from("auto"),
        },
        _ => Value::from("auto"),
    };
    if !["H264", "VP9", "VP8", "AV1"].contains(&c.codec.as_str()) { c.codec = d.codec; }
    if !["motion", "detail", "balanced"].contains(&c.priority.as_str()) { c.priority = d.priority; }
    c.mic.gain = clamp(c.mic.gain, 0.0, 2.0, 1.0);
    c.host_name = c.host_name.chars().take(64).collect();
    c.system_audio_device = c.system_audio_device.chars().take(300).collect();
    c.app_audio.blocked = normalize_exe_list(&c.app_audio.blocked);
    c.app_audio.allowed = normalize_exe_list(&c.app_audio.allowed);
    c.sfx.volume = clamp(c.sfx.volume, 0.0, 1.0, 0.5);
    let relay = c.signaling.relay.trim().trim_end_matches('/').to_string();
    c.signaling.relay = if valid_relay(&relay) { relay } else { d.signaling.relay };
    c.signaling.max_participants = c.signaling.max_participants.clamp(2, 12);
    let jp = c.discord.join_page_url.trim();
    c.discord.join_page_url = if jp.starts_with("https://") && jp.len() > 8 && !jp.contains(char::is_whitespace) && !jp.contains('#') { jp.to_string() } else { String::new() };
    c.stun.retain(|s| valid_stun(s));
    // configuração antiga (só 2 servidores do Google) passa a usar a lista nova
    if c.stun.len() == 2 && c.stun[0] == "stun:stun.l.google.com:19302" && c.stun[1] == "stun:stun1.l.google.com:19302" {
        c.stun = default_stun();
    }
    c.turn = turn::sanitize(&c.turn);
    c
}

pub fn load(file: &Path) -> Config {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| sanitize(&v))
        .unwrap_or_else(|| sanitize(&Value::Null))
}

/// Valida e grava de forma atômica (arquivo temporário + rename). Devolve a versão limpa.
pub fn save(file: &Path, raw: &Value) -> std::io::Result<Config> {
    let clean = sanitize(raw);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&clean).expect("Config serializa"))?;
    std::fs::rename(&tmp, file)?;
    Ok(clean)
}

pub fn default_dir() -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join("videobridge")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_when_empty_or_garbage() {
        assert_eq!(sanitize(&Value::Null), Config::default());
        assert_eq!(sanitize(&json!("texto")), Config::default());
    }

    #[test]
    fn wrong_types_fall_back_per_field_not_whole_file() {
        let c = sanitize(&json!({"hostName": 5, "fps": "30", "resolution": 720, "mic": {"gain": "alto"}}));
        assert_eq!(c.host_name, "");
        assert_eq!(c.fps, 60);
        assert_eq!(c.resolution, 720, "campo válido é mantido");
        assert_eq!(c.mic.gain, 1.0);
    }

    #[test]
    fn clamps_and_validates() {
        let c = sanitize(&json!({
            "resolution": 999, "fps": 24, "codec": "XYZ", "bitrate": 50, "priority": "x",
            "mic": {"gain": 9}, "sfx": {"volume": -1},
            "signaling": {"relay": "ftp://x", "maxParticipants": 99},
            "discord": {"joinPageUrl": "http://inseguro"},
            "stun": ["stun:a.com:3478", "http://x", "stun:"],
            "appAudio": {"blocked": ["Chrome.exe", "chrome.exe", "a|b", "../x"], "allowed": ["  Spotify.EXE "]},
        }));
        assert_eq!((c.resolution, c.fps), (1080, 60));
        assert_eq!(c.codec, "H264");
        assert_eq!(c.bitrate, json!("auto"));
        assert_eq!(c.mic.gain, 2.0);
        assert_eq!(c.sfx.volume, 0.0);
        assert_eq!(c.signaling.relay, "https://ntfy.sh");
        assert_eq!(c.signaling.max_participants, 12);
        assert_eq!(c.discord.join_page_url, "");
        assert_eq!(c.stun, vec!["stun:a.com:3478".to_string()]);
        assert_eq!(c.app_audio.blocked, vec!["chrome.exe".to_string()]);
        assert_eq!(c.app_audio.allowed, vec!["spotify.exe".to_string()]);
    }

    #[test]
    fn bitrate_accepts_number_and_numeric_string() {
        assert_eq!(sanitize(&json!({"bitrate": 4000})).bitrate, json!(4000));
        assert_eq!(sanitize(&json!({"bitrate": "6000"})).bitrate, json!(6000));
        assert_eq!(sanitize(&json!({"bitrate": 99999})).bitrate, json!("auto"));
    }

    #[test]
    fn old_two_server_stun_list_migrates() {
        let c = sanitize(&json!({"stun": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}));
        assert_eq!(c.stun.len(), 4);
    }

    #[test]
    fn save_is_atomic_and_roundtrips() {
        let dir = std::env::temp_dir().join(format!("vbcfg-{}", rand::random::<u32>()));
        let f = dir.join("config.json");
        let saved = save(&f, &json!({"hostName": "Ana", "fps": 30})).unwrap();
        assert!(!f.with_extension("json.tmp").exists());
        assert_eq!(load(&f), saved);
        assert_eq!(load(&f).host_name, "Ana");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn serialized_shape_matches_what_the_renderer_expects() {
        let v = serde_json::to_value(Config::default()).unwrap();
        for k in ["hostName", "systemAudioDevice", "shareTurn", "appAudio", "startMinimized"] {
            assert!(v.get(k).is_some(), "falta {k}");
        }
        assert_eq!(v["appAudio"]["allowNew"], json!(true));
        assert_eq!(v["hotkeys"]["toggleStream"], json!("Control+Shift+V"));
    }
}
