//! Log estruturado em JSON-lines. Redige tokens/convites; nunca registra mídia.
//! Melhoria: rotação (o app em Electron anexava para sempre, sem limite de tamanho).
use regex::Regex;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn redactions() -> &'static [(Regex, &'static str)] {
    static R: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    R.get_or_init(|| {
        vec![
            (Regex::new(r"(?i)(webhooks/\d+/)[\w-]+").unwrap(), "${1}[REDACTED]"),
            (Regex::new(r"VB[123]\.[A-Za-z0-9_-]{22}(\.[A-Za-z0-9_-]+)?").unwrap(), "VB3.[INVITE]"),
            (Regex::new(r#"(?i)(token|password|senha|credential|username)(["']?\s*[:=]\s*["']?)[^\s"',}]+"#).unwrap(), "${1}${2}[REDACTED]"),
        ]
    })
}

pub fn redact(text: &str) -> String {
    redactions().iter().fold(text.to_string(), |t, (re, rep)| re.replace_all(&t, *rep).into_owned())
}

pub struct Logger {
    path: Option<PathBuf>,
    file: Mutex<Option<(File, u64)>>,
}

impl Logger {
    pub fn new(path: Option<PathBuf>) -> Self {
        let file = path.as_ref().and_then(|p| {
            std::fs::create_dir_all(p.parent()?).ok()?;
            let f = OpenOptions::new().create(true).append(true).open(p).ok()?;
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            Some((f, len))
        });
        Self { path, file: Mutex::new(file) }
    }

    /// Monta a linha (testável sem tocar no disco).
    pub fn line(level: &str, msg: &str, extra: Option<Value>) -> String {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        let mut obj = json!({ "t": secs, "level": level, "msg": msg });
        if let (Some(Value::Object(e)), Some(o)) = (extra, obj.as_object_mut()) {
            for (k, v) in e {
                o.entry(k).or_insert(v);
            }
        }
        redact(&obj.to_string())
    }

    pub fn write(&self, level: &str, msg: &str, extra: Option<Value>) {
        let line = Self::line(level, msg, extra);
        let Ok(mut guard) = self.file.lock() else { return };
        if let (Some((f, len)), Some(p)) = (guard.as_mut(), self.path.as_ref()) {
            if *len > MAX_BYTES {
                let _ = std::fs::rename(p, p.with_extension("old.log"));
                if let Ok(nf) = OpenOptions::new().create(true).append(true).open(p) {
                    *f = nf;
                    *len = 0;
                }
            }
            if writeln!(f, "{line}").is_ok() {
                *len += line.len() as u64 + 1;
            }
        }
    }
    pub fn info(&self, m: &str, e: Option<Value>) { self.write("INFO", m, e) }
    pub fn warn(&self, m: &str, e: Option<Value>) { self.write("WARN", m, e) }
    pub fn error(&self, m: &str, e: Option<Value>) { self.write("ERROR", m, e) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_webhook_tokens_invites_and_credentials() {
        let s = redact("POST https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL and VB3.abcdefghijklmnopqrstuv and {\"credential\":\"segredo\",\"username\":\"joao\"}");
        assert!(!s.contains("abcDEF_ghi"));
        assert!(!s.contains("abcdefghijklmnopqrstuv"));
        assert!(!s.contains("segredo") && !s.contains("joao"));
    }
    #[test]
    fn line_is_valid_json_and_redacted() {
        let l = Logger::line("INFO", "entrou VB3.abcdefghijklmnopqrstuv", Some(json!({"peer": "x"})));
        let v: Value = serde_json::from_str(&l).unwrap();
        assert_eq!(v["peer"], "x");
        assert!(!l.contains("abcdefghijklmnopqrstuv"));
    }
}
