//! Signaling via relay pub/sub compatível com ntfy (https://docs.ntfy.sh):
//!   publicar:  POST {relay}/{tópico}                     (corpo = mensagem, limite ~4 KB)
//!   assinar:   GET  {relay}/{tópico}/json?since=all|<id> (JSON por linha, conexão longa)
//! Tudo é cifrado (`room.rs`) antes de sair; mensagens grandes são divididas em pedaços.
//!
//! Melhorias em relação ao app em Electron:
//!  * **timeout de leitura**: o relay manda um "keepalive" a cada ~45 s; se nada chegar em 90 s a conexão é
//!    considerada morta e refeita. Antes, uma conexão que morria em silêncio (NAT/Wi-Fi) deixava o app
//!    "online" para sempre sem receber mais nada;
//!  * publicações serializadas (os pedaços de uma mensagem nunca se intercalam com os de outra);
//!  * tentativas com *backoff* e respeito ao `Retry-After` (HTTP 429);
//!  * a lógica de recebimento (`Inbox`) é uma máquina de estados pura, testada sem rede.
use crate::room::{RoomKeys, DEFAULT_RELAY};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex, Notify};

pub const MAX_CHUNK: usize = 3000;
const PARTIAL_TTL: Duration = Duration::from_secs(60);
const READ_TIMEOUT: Duration = Duration::from_secs(90);
const MARKER_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Online,
    Offline,
    /// Histórico descartado: já dá para anunciar a chegada.
    Live,
    /// O último participante encerrou a sala: o código não vale mais.
    Closed,
}
impl State {
    pub fn as_str(self) -> &'static str {
        match self { State::Online => "online", State::Offline => "offline", State::Live => "live", State::Closed => "closed" }
    }
}

#[derive(Debug, Clone)]
pub enum Event {
    Message(Value),
    Status { state: State, error: Option<String> },
}

// ---------------------------------------------------------------------------------------------
// Recebimento (puro)
// ---------------------------------------------------------------------------------------------
#[derive(Debug, PartialEq)]
pub enum InboxOut {
    Message(Value),
    GoLive { closed: bool },
}

struct Partial {
    parts: Vec<Option<String>>,
    got: usize,
    at: Instant,
}

/// Decodifica o que chega do relay: pedaços, marcador de histórico, eco próprio, mensagens adulteradas.
pub struct Inbox {
    keys: Arc<RoomKeys>,
    role: String,
    skipping: bool,
    marker: Option<String>,
    saw_closed: bool,
    partial: HashMap<String, Partial>,
}

impl Inbox {
    pub fn new(keys: Arc<RoomKeys>, role: &str, skip_history: bool) -> Self {
        let marker = skip_history.then(|| {
            use rand::RngCore;
            let mut b = [0u8; 6];
            rand::thread_rng().fill_bytes(&mut b);
            base64_url(&b)
        });
        Self { keys, role: role.into(), skipping: skip_history, marker, saw_closed: false, partial: HashMap::new() }
    }
    pub fn marker(&self) -> Option<&str> { self.marker.as_deref() }
    pub fn skipping(&self) -> bool { self.skipping }
    pub fn saw_closed(&self) -> bool { self.saw_closed }

    /// O marcador não voltou a tempo: segue sem ele.
    pub fn force_live(&mut self) -> Option<InboxOut> {
        if !self.skipping { return None; }
        self.skipping = false;
        Some(InboxOut::GoLive { closed: self.saw_closed })
    }

    pub fn handle_text(&mut self, text: &str, now: Instant) -> Option<InboxOut> {
        if let Some(sealed) = text.strip_prefix("1|") {
            return self.deliver(sealed);
        }
        // c|<id>|<i>|<n>|<dados>
        let mut it = text.splitn(5, '|');
        if it.next()? != "c" { return None; }
        let id = it.next()?;
        let (i, n): (usize, usize) = (it.next()?.parse().ok()?, it.next()?.parse().ok()?);
        let data = it.next()?;
        let ok_id = (4..=16).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
        let ok_data = !data.is_empty() && data.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
        if !ok_id || !ok_data || n < 1 || n > 200 || i >= n { return None; }
        self.partial.retain(|_, p| now.duration_since(p.at) <= PARTIAL_TTL);
        let p = self.partial.entry(id.to_string()).or_insert_with(|| Partial { parts: vec![None; n], got: 0, at: now });
        if p.parts.len() != n { return None; }
        if p.parts[i].is_none() {
            p.parts[i] = Some(data.to_string());
            p.got += 1;
        }
        if p.got == n {
            let p = self.partial.remove(id)?;
            let joined: String = p.parts.into_iter().flatten().collect();
            return self.deliver(&joined);
        }
        None
    }

    fn deliver(&mut self, sealed: &str) -> Option<InboxOut> {
        let obj = self.keys.open(sealed).ok()?; // adulterada / de outra sala: ignora
        let t = obj.get("t").and_then(Value::as_str);
        let r = obj.get("r").and_then(Value::as_str);
        if t == Some("_m") {
            // marcador: nunca vai ao app
            if self.skipping && obj.get("n").and_then(Value::as_str) == self.marker.as_deref() && r == Some(self.role.as_str()) {
                self.skipping = false;
                return Some(InboxOut::GoLive { closed: self.saw_closed });
            }
            return None;
        }
        if self.skipping {
            // histórico anterior à minha entrada, mas vejo se a sala já foi encerrada
            if t == Some("closed") { self.saw_closed = true; }
            return None;
        }
        if !obj.is_object() || r == Some(self.role.as_str()) { return None; } // ignora o próprio eco
        Some(InboxOut::Message(obj))
    }
}

fn base64_url(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Janela de IDs já vistos (o relay reentrega o histórico ao reconectar).
struct Seen {
    set: HashSet<String>,
    order: VecDeque<String>,
    cap: usize,
}
impl Seen {
    fn new(cap: usize) -> Self { Self { set: HashSet::new(), order: VecDeque::new(), cap } }
    /// `true` se é novo.
    fn insert(&mut self, id: &str) -> bool {
        if !self.set.insert(id.to_string()) { return false; }
        self.order.push_back(id.to_string());
        if self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() { self.set.remove(&old); }
        }
        true
    }
}

fn pct(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// ---------------------------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------------------------
#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("Sinalização encerrada.")]
    Closed,
    #[error("Relay respondeu HTTP {0}")]
    Http(u16),
    #[error("falha de rede: {0}")]
    Net(String),
}

pub struct RelayConfig {
    pub relay: String,
    pub secret: String,
    /// ID do participante (só serve para ignorar o próprio eco).
    pub role: String,
    pub skip_history: bool,
}

pub struct Relay {
    http: reqwest::Client,
    base: String,
    keys: Arc<RoomKeys>,
    role: String,
    closed: AtomicBool,
    stop: Notify,
    marker_failed: Notify,
    publish_lock: Mutex<()>,
    tx: mpsc::UnboundedSender<Event>,
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("VideoBridge/", env!("CARGO_PKG_VERSION")))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .expect("cliente HTTP")
}

impl Relay {
    /// Inicia a assinatura em segundo plano. Precisa de um runtime Tokio ativo.
    pub fn start(cfg: RelayConfig) -> (Arc<Relay>, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let keys = Arc::new(RoomKeys::new(&cfg.secret));
        let base = if cfg.relay.is_empty() { DEFAULT_RELAY.to_string() } else { cfg.relay.trim_end_matches('/').to_string() };
        let me = Arc::new(Relay {
            http: http_client(),
            base,
            keys: keys.clone(),
            role: cfg.role.clone(),
            closed: AtomicBool::new(false),
            stop: Notify::new(),
            marker_failed: Notify::new(),
            publish_lock: Mutex::new(()),
            tx,
        });
        let inbox = Inbox::new(keys, &cfg.role, cfg.skip_history);
        tokio::spawn(me.clone().run(inbox));
        (me, rx)
    }

    /// Cliente só para publicar (sem assinatura).
    pub fn publisher(relay: &str, secret: &str, role: &str) -> Arc<Relay> {
        let (tx, _rx) = mpsc::unbounded_channel();
        Arc::new(Relay {
            http: http_client(),
            base: relay.trim_end_matches('/').to_string(),
            keys: Arc::new(RoomKeys::new(secret)),
            role: role.into(),
            closed: AtomicBool::new(false),
            stop: Notify::new(),
            marker_failed: Notify::new(),
            publish_lock: Mutex::new(()),
            tx,
        })
    }

    pub fn topic(&self) -> &str { &self.keys.topic }
    fn is_closed(&self) -> bool { self.closed.load(Ordering::SeqCst) }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.stop.notify_waiters();
        self.stop.notify_one();
    }

    fn status(&self, last: &mut Option<State>, s: State, err: Option<String>) {
        if *last != Some(s) {
            *last = Some(s);
            let _ = self.tx.send(Event::Status { state: s, error: err });
        }
    }

    async fn post(&self, text: String) -> Result<(), RelayError> {
        let mut last = RelayError::Closed;
        for attempt in 0..3u32 {
            let res = self.http.post(format!("{}/{}", self.base, self.keys.topic)).header("Content-Type", "text/plain; charset=utf-8").body(text.clone()).send().await;
            match res {
                Ok(r) if r.status().is_success() => return Ok(()),
                Ok(r) => {
                    let code = r.status().as_u16();
                    last = RelayError::Http(code);
                    let wait = if code == 429 {
                        r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(2).min(10) * 1000
                    } else if code >= 500 { 300 * 2u64.pow(attempt) } else { return Err(last) }; // 4xx (exceto 429) não adianta repetir
                    if attempt < 2 { tokio::time::sleep(Duration::from_millis(wait)).await; }
                }
                Err(e) => {
                    last = RelayError::Net(e.to_string());
                    if attempt < 2 { tokio::time::sleep(Duration::from_millis(300 * 2u64.pow(attempt))).await; }
                }
            }
        }
        Err(last)
    }

    pub async fn publish(&self, mut obj: Value) -> Result<(), RelayError> {
        if self.is_closed() { return Err(RelayError::Closed); }
        if let Some(o) = obj.as_object_mut() {
            o.insert("r".into(), json!(self.role));
            o.insert("ts".into(), json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)));
        }
        let sealed = self.keys.seal(&obj);
        let _order = self.publish_lock.lock().await; // os pedaços de uma mensagem não se misturam com os de outra
        if sealed.len() + 2 <= MAX_CHUNK {
            return self.post(format!("1|{sealed}")).await;
        }
        use rand::RngCore;
        let mut b = [0u8; 6];
        rand::thread_rng().fill_bytes(&mut b);
        let id = base64_url(&b);
        let n = sealed.len().div_ceil(MAX_CHUNK);
        for i in 0..n {
            let part = &sealed[i * MAX_CHUNK..((i + 1) * MAX_CHUNK).min(sealed.len())]; // base64url é ASCII: corte seguro
            self.post(format!("c|{id}|{i}|{n}|{part}")).await?;
        }
        Ok(())
    }

    async fn run(self: Arc<Self>, mut inbox: Inbox) {
        let mut since = "all".to_string();
        let mut seen = Seen::new(4000);
        let mut backoff = 1000u64;
        let mut last: Option<State> = None;
        let mut marker_sent = false;
        let mut deadline: Option<tokio::time::Instant> = None;
        let skip = inbox.marker().is_some();

        while !self.is_closed() {
            let url = format!("{}/{}/json?since={}", self.base, self.keys.topic, pct(&since));
            let resp = tokio::select! { r = self.http.get(&url).send() => r, _ = self.stop.notified() => return };
            let err_text = match resp {
                Ok(r) if r.status().is_success() => {
                    self.status(&mut last, State::Online, None);
                    backoff = 1000;
                    if skip && !marker_sent {
                        marker_sent = true;
                        deadline = Some(tokio::time::Instant::now() + MARKER_TIMEOUT);
                        let me = self.clone();
                        let m = inbox.marker().unwrap_or_default().to_string();
                        tokio::spawn(async move {
                            if me.publish(json!({"t": "_m", "n": m})).await.is_err() { me.marker_failed.notify_one(); }
                        });
                    } else if skip && !inbox.skipping() && !inbox.saw_closed() {
                        self.status(&mut last, State::Live, None);
                    }
                    let mut stream = r.bytes_stream();
                    let mut buf: Vec<u8> = Vec::new();
                    let end: Option<String> = 'conn: loop {
                        let dl = deadline; // cópia: o handler abaixo pode zerar `deadline`
                        let wait = async move {
                            match dl { Some(d) => tokio::time::sleep_until(d).await, None => std::future::pending::<()>().await }
                        };
                        let outs: Vec<InboxOut> = tokio::select! {
                            _ = self.stop.notified() => return,
                            _ = self.marker_failed.notified() => inbox.force_live().into_iter().collect(),
                            _ = wait => { deadline = None; inbox.force_live().into_iter().collect() }
                            chunk = tokio::time::timeout(READ_TIMEOUT, stream.next()) => match chunk {
                                Err(_) => break 'conn Some("o relay ficou em silêncio por 90 s; reconectando".into()),
                                Ok(None) => break 'conn Some("conexão com o relay encerrada; reconectando".into()),
                                Ok(Some(Err(e))) => break 'conn Some(e.to_string()),
                                Ok(Some(Ok(bytes))) => {
                                    buf.extend_from_slice(&bytes);
                                    let mut outs = Vec::new();
                                    while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                                        let line: Vec<u8> = buf.drain(..=i).collect();
                                        if let Some(o) = self.handle_line(&line, &mut inbox, &mut seen, &mut since) { outs.push(o); }
                                    }
                                    if buf.len() > 1 << 20 { buf.clear(); } // lixo sem quebra de linha
                                    outs
                                }
                            }
                        };
                        for o in outs {
                            match o {
                                InboxOut::Message(m) => { let _ = self.tx.send(Event::Message(m)); }
                                InboxOut::GoLive { closed } => {
                                    deadline = None;
                                    self.status(&mut last, if closed { State::Closed } else { State::Live }, None);
                                }
                            }
                        }
                    };
                    end
                }
                Ok(r) => Some(format!("Relay respondeu HTTP {}", r.status().as_u16())),
                Err(e) => Some(e.to_string()),
            };
            if self.is_closed() { return; }
            self.status(&mut last, State::Offline, err_text);
            tokio::select! { _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}, _ = self.stop.notified() => return }
            backoff = (backoff * 2).min(10_000);
        }
    }

    fn handle_line(&self, line: &[u8], inbox: &mut Inbox, seen: &mut Seen, since: &mut String) -> Option<InboxOut> {
        let ev: Value = serde_json::from_slice(line.trim_ascii()).ok()?;
        if ev.get("event")?.as_str()? != "message" { return None; }
        let msg = ev.get("message")?.as_str()?;
        if let Some(id) = ev.get("id").and_then(Value::as_str) {
            if !seen.insert(id) { return None; }
            *since = id.to_string();
        }
        inbox.handle_text(msg, Instant::now())
    }
}

#[derive(Debug, serde::Serialize)]
pub struct SelfTest {
    pub ok: bool,
    pub ms: u64,
    pub relay: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Diagnóstico: duas pontas no mesmo tópico; uma publica, a outra precisa receber em 8 s.
pub async fn self_test(relay: &str) -> SelfTest {
    let t0 = Instant::now();
    let secret = crate::room::new_secret();
    let (a, mut rx) = Relay::start(RelayConfig { relay: relay.into(), secret: secret.clone(), role: "diagA".into(), skip_history: false });
    let b = Relay::publisher(relay, &secret, "diagB");
    let result = async {
        // dá um instante para a assinatura de A ficar de pé antes de B publicar (o histórico cobre a corrida mesmo assim)
        tokio::time::sleep(Duration::from_millis(300)).await;
        b.publish(json!({"t": "ping"})).await.map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(8), async {
            while let Some(ev) = rx.recv().await {
                if let Event::Message(m) = ev { if m["t"] == "ping" { return true; } }
            }
            false
        })
        .await
        .map_err(|_| "sem resposta do relay em 8 s".to_string())
        .and_then(|ok| if ok { Ok(()) } else { Err("assinatura encerrada".to_string()) })
    }
    .await;
    a.close();
    b.close();
    SelfTest { ok: result.is_ok(), ms: t0.elapsed().as_millis() as u64, relay: relay.into(), error: result.err() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> Arc<RoomKeys> { Arc::new(RoomKeys::new(&crate::room::new_secret())) }
    fn wire(k: &RoomKeys, v: Value) -> String { format!("1|{}", k.seal(&v)) }
    fn now() -> Instant { Instant::now() }

    #[test]
    fn delivers_other_peers_and_drops_own_echo() {
        let k = keys();
        let mut ib = Inbox::new(k.clone(), "eu", false);
        assert_eq!(ib.handle_text(&wire(&k, json!({"t":"hello","r":"eu"})), now()), None);
        let m = ib.handle_text(&wire(&k, json!({"t":"hello","r":"outro"})), now());
        assert!(matches!(m, Some(InboxOut::Message(v)) if v["r"] == "outro"));
    }

    #[test]
    fn drops_tampered_and_foreign_room_messages() {
        let k = keys();
        let mut ib = Inbox::new(k.clone(), "eu", false);
        let other = RoomKeys::new(&crate::room::new_secret());
        assert_eq!(ib.handle_text(&wire(&other, json!({"t":"hello","r":"x"})), now()), None);
        assert_eq!(ib.handle_text("1|lixo", now()), None);
        assert_eq!(ib.handle_text("qualquer coisa", now()), None);
    }

    #[test]
    fn skips_history_until_own_marker_returns() {
        let k = keys();
        let mut ib = Inbox::new(k.clone(), "eu", true);
        let marker = ib.marker().unwrap().to_string();
        // histórico de quem já saiu: descartado
        assert_eq!(ib.handle_text(&wire(&k, json!({"t":"hello","r":"antigo"})), now()), None);
        // marcador de OUTRA pessoa não libera
        assert_eq!(ib.handle_text(&wire(&k, json!({"t":"_m","n": marker.clone(), "r":"outro"})), now()), None);
        assert!(ib.skipping());
        assert_eq!(ib.handle_text(&wire(&k, json!({"t":"_m","n": marker, "r":"eu"})), now()), Some(InboxOut::GoLive { closed: false }));
        assert!(matches!(ib.handle_text(&wire(&k, json!({"t":"hello","r":"novo"})), now()), Some(InboxOut::Message(_))));
    }

    #[test]
    fn history_with_closed_marks_room_closed() {
        let k = keys();
        let mut ib = Inbox::new(k.clone(), "eu", true);
        let marker = ib.marker().unwrap().to_string();
        ib.handle_text(&wire(&k, json!({"t":"closed","r":"antigo"})), now());
        assert!(ib.saw_closed());
        assert_eq!(ib.handle_text(&wire(&k, json!({"t":"_m","n": marker, "r":"eu"})), now()), Some(InboxOut::GoLive { closed: true }));
    }

    #[test]
    fn force_live_when_marker_never_returns() {
        let mut ib = Inbox::new(keys(), "eu", true);
        assert_eq!(ib.force_live(), Some(InboxOut::GoLive { closed: false }));
        assert_eq!(ib.force_live(), None);
    }

    #[test]
    fn markers_never_reach_the_app() {
        let k = keys();
        let mut ib = Inbox::new(k.clone(), "eu", false);
        assert_eq!(ib.handle_text(&wire(&k, json!({"t":"_m","n":"x","r":"outro"})), now()), None);
    }

    #[test]
    fn reassembles_chunks_in_any_order_and_ignores_duplicates() {
        let k = keys();
        let big = json!({"t":"desc","r":"outro","x": "A".repeat(500)});
        let sealed = k.seal(&big);
        let n = 3;
        let size = sealed.len().div_ceil(n);
        let parts: Vec<String> = (0..n).map(|i| format!("c|abcd1234|{i}|{n}|{}", &sealed[i * size..((i + 1) * size).min(sealed.len())])).collect();
        let mut ib = Inbox::new(k, "eu", false);
        assert_eq!(ib.handle_text(&parts[2], now()), None);
        assert_eq!(ib.handle_text(&parts[2], now()), None, "duplicado");
        assert_eq!(ib.handle_text(&parts[0], now()), None);
        let out = ib.handle_text(&parts[1], now());
        assert!(matches!(out, Some(InboxOut::Message(v)) if v["t"] == "desc"));
    }

    #[test]
    fn rejects_malformed_chunks() {
        let mut ib = Inbox::new(keys(), "eu", false);
        for bad in ["c|ab|0|1|x", "c|abcd|5|3|xx", "c|abcd|0|0|xx", "c|abcd|0|999|xx", "c|abcd|0|2|", "c|abcd|0|2|a b", "c|abcd|x|2|aa"] {
            assert_eq!(ib.handle_text(bad, now()), None, "{bad}");
        }
    }

    #[test]
    fn stale_partials_expire() {
        let k = keys();
        let mut ib = Inbox::new(k, "eu", false);
        let t0 = now();
        ib.handle_text("c|abcd1234|0|2|aaaa", t0);
        ib.handle_text("c|zzzz9999|0|2|bbbb", t0 + PARTIAL_TTL + Duration::from_secs(1));
        assert!(!ib.partial.contains_key("abcd1234"));
    }

    #[test]
    fn seen_window_is_bounded() {
        let mut s = Seen::new(3);
        assert!(s.insert("a") && !s.insert("a"));
        s.insert("b"); s.insert("c"); s.insert("d");
        assert_eq!(s.set.len(), 3);
        assert!(s.insert("a"), "o mais antigo foi esquecido");
    }

    #[test]
    fn percent_encoding_of_since() {
        assert_eq!(pct("all"), "all");
        assert_eq!(pct("a b/c"), "a%20b%2Fc");
    }
}
