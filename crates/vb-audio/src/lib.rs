//! Áudio POR APLICATIVO no Windows (10 build 19041+), em processo, sem helper externo.
//!
//! Substitui `native/VbAudio.cs` (1,7 mil linhas de C# compiladas no PC do usuário com `csc.exe`,
//! falando com o Node por stdin/stdout/stderr): aqui a captura roda numa thread do próprio app, o PCM
//! mixado chega por um *callback* e não existe etapa de compilação, cache de .exe nem processo filho.
pub mod mixer;
pub mod policy;

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub use policy::Policy;

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Format {
    pub rate: u32,
    pub channels: u16,
    pub bits: u16,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub key: String,
    pub name: String,
    pub pid: u32,
    pub active: bool,
    pub peak: f32,
    pub included: bool,
    pub capturing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Eventos para a interface (mesmo formato JSON que o helper em C# emitia).
#[derive(Debug, Clone)]
pub enum Event {
    Apps(Vec<AppInfo>),
    CaptureError { app: String, message: String },
    ScanError(String),
    Exit { code: i32, error: Option<String> },
}

impl Event {
    pub fn to_json(&self) -> Value {
        match self {
            Event::Apps(a) => json!({"event": "apps", "apps": a}),
            Event::CaptureError { app, message } => json!({"event": "capture_error", "app": app, "message": message}),
            Event::ScanError(m) => json!({"event": "scan_error", "message": m}),
            Event::Exit { code, error } => json!({"event": "exit", "code": code, "error": error}),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeRow {
    pub name: String,
    pub hr: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct TestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub type PcmSink = Arc<dyn Fn(&[i16]) + Send + Sync>;
pub type EventSink = Arc<dyn Fn(Event) + Send + Sync>;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::Service;

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use stub::Service;
