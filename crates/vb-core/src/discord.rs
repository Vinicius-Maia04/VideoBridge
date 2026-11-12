//! Integração com o Discord somente via WEBHOOK DE CANAL (API oficial, sem bot, sem hospedagem):
//!  * `POST   /webhooks/{id}/{token}?wait=true`        → cria a mensagem
//!  * `PATCH  /webhooks/{id}/{token}/messages/{mid}`   → edita
//!  * `DELETE /webhooks/{id}/{token}/messages/{mid}`   → remove
//!
//! Limitação oficial: webhooks comuns não enviam botões; o convite vai como link markdown + código.
//!
//! Melhorias em relação ao app em Electron:
//!  * **sem mensagem órfã**: o id da mensagem fica salvo em disco; se o app morrer (queda de energia,
//!    processo encerrado), o aviso antigo é apagado na próxima abertura;
//!  * **atualizações agrupadas** (no máximo uma edição a cada 1,5 s): ligar/desligar fontes em sequência
//!    não estoura o limite de taxa do webhook;
//!  * respeita `Retry-After`/`retry_after` do Discord (3 tentativas) em vez de uma só;
//!  * mensagem em *embed* (campos de fontes e código) com horário relativo ("há 3 minutos") nativo do Discord;
//!  * nomes escapados (um nome como `[clique](http://x)` não vira link na mensagem).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

pub const MAX_CONTENT: usize = 2000;
const MAX_DESC: usize = 4096;
const MAX_FIELD: usize = 1024;
const MIN_EDIT_GAP: Duration = Duration::from_millis(1500);

#[derive(Debug, thiserror::Error)]
pub enum DiscordError {
    #[error("URL de webhook do Discord inválida.")]
    BadUrl,
    #[error("Discord respondeu HTTP {0}.")]
    Http(u16),
    #[error("Discord: limite de requisições excedido.")]
    RateLimited,
    #[error("Mensagem grande demais para o Discord ({0}/{1}).")]
    TooBig(usize, usize),
    #[error("falha de rede: {0}")]
    Net(String),
    #[error("Sessão do Discord encerrada.")]
    Gone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Webhook {
    pub id: String,
    pub base: String,
}

/// `https://[canary.|ptb.]discord(app).com/api[/vN]/webhooks/{id 15-25 dígitos}/{token 20-120}`
pub fn parse_webhook_url(url: &str) -> Result<Webhook, DiscordError> {
    let u = url.trim();
    let rest = u.strip_prefix("https://").ok_or(DiscordError::BadUrl)?;
    let (host, path) = rest.split_once('/').ok_or(DiscordError::BadUrl)?;
    let host = host.strip_prefix("canary.").or_else(|| host.strip_prefix("ptb.")).unwrap_or(host);
    if host != "discord.com" && host != "discordapp.com" {
        return Err(DiscordError::BadUrl);
    }
    let mut seg = path.split('/');
    if seg.next() != Some("api") {
        return Err(DiscordError::BadUrl);
    }
    let mut next = seg.next();
    if let Some(v) = next {
        if v.len() > 1 && v.starts_with('v') && v[1..].bytes().all(|c| c.is_ascii_digit()) {
            next = seg.next();
        }
    }
    if next != Some("webhooks") {
        return Err(DiscordError::BadUrl);
    }
    let (id, token) = (seg.next().ok_or(DiscordError::BadUrl)?, seg.next().ok_or(DiscordError::BadUrl)?);
    if seg.next().is_some()
        || !(15..=25).contains(&id.len())
        || !id.bytes().all(|c| c.is_ascii_digit())
        || !(20..=120).contains(&token.len())
        || !token.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(DiscordError::BadUrl);
    }
    Ok(Webhook { id: id.into(), base: format!("https://discord.com/api/webhooks/{id}/{token}") })
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Announcement {
    pub host: String,
    pub sources: Vec<String>,
    pub invite: String,
    pub join_url: String,
    /// Quantas pessoas estão na sala (0 = não mostrar).
    pub people: u32,
}

fn escape_md(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\*_~|>`[]()<@#".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// `https://x.github.io/repo/#VB3.…` → `https://x.github.io/repo/` (pasta da página-ponte, onde fica o `logo.png`).
fn page_base(join_url: &str) -> Option<String> {
    let mut u = join_url.split(['#', '?']).next()?.to_string();
    if !u.starts_with("https://") {
        return None;
    }
    if u.ends_with(".html") {
        u.truncate(u.rfind('/')? + 1);
    }
    if !u.ends_with('/') {
        u.push('/');
    }
    Some(u)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max - 1).collect::<String>()) }
}

pub fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Corpo do POST/PATCH. `started` = instante (Unix) em que a sala/transmissão começou.
/// Sem fontes = "sala aberta" (verde); com fontes = "transmissão ao vivo" (vermelho).
pub fn build_payload(a: &Announcement, live: bool, started: u64) -> Result<Value, DiscordError> {
    let host = if a.host.trim().is_empty() { "Alguém".to_string() } else { escape_md(a.host.trim()) };
    if !live {
        return Ok(json!({ "content": format!("⏹️ A sala de **{host}** foi encerrada"), "embeds": [], "allowed_mentions": {"parse": []} }));
    }
    let sharing = !a.sources.is_empty();
    let content = if sharing { format!("🎥 **{host}** iniciou uma transmissão") } else { format!("🟢 **{host}** abriu uma sala") };
    let watch = if a.join_url.is_empty() { String::new() } else { format!("▶️ **[Entrar na sala]({})**\n", a.join_url) };
    let desc = format!("{watch}{} <t:{started}:R>\n*Clique no link (o navegador pede para abrir o VideoBridge) ou cole o código em Assistir.*", if sharing { "Começou" } else { "Sala aberta" });
    if content.chars().count() > MAX_CONTENT {
        return Err(DiscordError::TooBig(content.chars().count(), MAX_CONTENT));
    }
    if desc.chars().count() > MAX_DESC {
        return Err(DiscordError::TooBig(desc.chars().count(), MAX_DESC));
    }
    let mut fields = Vec::new();
    if sharing {
        let list = a.sources.iter().map(|s| format!("• {}", escape_md(s))).collect::<Vec<_>>().join("\n");
        fields.push(json!({"name": "Fontes", "value": truncate(&list, MAX_FIELD)}));
    }
    fields.push(json!({"name": "Código", "value": format!("`{}`", truncate(&a.invite, 200))}));
    let mut embed = json!({
        "title": if sharing { "Transmissão ao vivo" } else { "Sala aberta" },
        "description": desc,
        "color": if sharing { 0xED4245 } else { 0x57F287 },
        "fields": fields,
    });
    if !a.join_url.is_empty() {
        embed["url"] = json!(a.join_url); // o título do cartão também vira link
        if let Some(base) = page_base(&a.join_url) {
            embed["thumbnail"] = json!({ "url": format!("{base}logo.png") }); // a página-ponte hospeda a logo
        }
    }
    if a.people > 0 {
        embed["footer"] = json!({"text": format!("👥 {} na sala", a.people)});
    }
    Ok(json!({ "content": content, "allowed_mentions": {"parse": []}, "embeds": [embed] }))
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
#[derive(Clone)]
pub struct DiscordClient {
    http: reqwest::Client,
}

impl Default for DiscordClient {
    fn default() -> Self { Self::new() }
}

impl DiscordClient {
    pub fn new() -> Self {
        Self { http: reqwest::Client::builder().timeout(Duration::from_secs(10)).user_agent(concat!("VideoBridge/", env!("CARGO_PKG_VERSION"))).build().expect("cliente HTTP") }
    }

    async fn call(&self, method: reqwest::Method, url: &str, body: Option<&Value>) -> Result<Option<Value>, DiscordError> {
        for attempt in 0..3 {
            let mut rb = self.http.request(method.clone(), url);
            if let Some(b) = body { rb = rb.json(b); }
            let res = rb.send().await.map_err(|e| DiscordError::Net(e.to_string()))?;
            let status = res.status().as_u16();
            if status == 429 && attempt < 2 {
                let hdr = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<f64>().ok());
                let j: Value = res.json().await.unwrap_or(Value::Null);
                let secs = j.get("retry_after").and_then(Value::as_f64).or(hdr).unwrap_or(1.0).clamp(0.1, 5.0);
                tokio::time::sleep(Duration::from_secs_f64(secs)).await;
                continue;
            }
            if status == 429 { return Err(DiscordError::RateLimited); }
            if !(200..300).contains(&status) { return Err(DiscordError::Http(status)); }
            return Ok(if status == 204 { None } else { res.json().await.ok() });
        }
        Err(DiscordError::RateLimited)
    }

    pub async fn announce(&self, hook: &Webhook, a: &Announcement, started: u64) -> Result<String, DiscordError> {
        let mut body = build_payload(a, true, started)?;
        body["username"] = json!("VideoBridge");
        let j = self.call(reqwest::Method::POST, &format!("{}?wait=true", hook.base), Some(&body)).await?;
        j.and_then(|j| j.get("id").and_then(Value::as_str).map(String::from)).ok_or(DiscordError::Http(200))
    }
    pub async fn update(&self, hook: &Webhook, id: &str, a: &Announcement, started: u64) -> Result<(), DiscordError> {
        let body = build_payload(a, true, started)?;
        self.call(reqwest::Method::PATCH, &format!("{}/messages/{id}", hook.base), Some(&body)).await.map(|_| ())
    }
    /// Remove o aviso; se não conseguir apagar, ao menos marca como encerrado.
    pub async fn end(&self, hook: &Webhook, id: &str, host: &str) -> Result<(), DiscordError> {
        let url = format!("{}/messages/{id}", hook.base);
        match self.call(reqwest::Method::DELETE, &url, None).await {
            Ok(_) | Err(DiscordError::Http(404)) => Ok(()),
            Err(_) => {
                let body = build_payload(&Announcement { host: host.into(), ..Default::default() }, false, 0)?;
                self.call(reqwest::Method::PATCH, &url, Some(&body)).await.map(|_| ())
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Sessão (um aviso por vez; atualizações agrupadas; limpeza de órfãos)
// ---------------------------------------------------------------------------------------------
fn pending_file(dir: &Path) -> PathBuf { dir.join("discord_pending.json") }

fn save_pending(dir: &Path, hook: &Webhook, msg_id: &str) {
    // só o id (público) do webhook e da mensagem: o token nunca vai para o disco aqui
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(pending_file(dir), json!({"webhookId": hook.id, "messageId": msg_id}).to_string());
}
fn clear_pending(dir: &Path) { let _ = std::fs::remove_file(pending_file(dir)); }

/// Apaga o aviso de uma sessão anterior que não chegou a se despedir. Chame ao iniciar o app.
pub async fn cleanup_orphan(client: &DiscordClient, webhook_url: &str, dir: &Path) {
    let Ok(text) = std::fs::read_to_string(pending_file(dir)) else { return };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return clear_pending(dir) };
    if let (Ok(hook), Some(wid), Some(mid)) = (parse_webhook_url(webhook_url), v["webhookId"].as_str(), v["messageId"].as_str()) {
        if hook.id == wid && mid.bytes().all(|c| c.is_ascii_digit()) {
            let _ = client.end(&hook, mid, "").await;
        }
    }
    clear_pending(dir);
}

enum Cmd {
    Announce(Announcement, oneshot::Sender<Result<String, DiscordError>>),
    Update(Announcement),
    End(oneshot::Sender<()>),
    /// Larga a mensagem SEM apagá-la (outro participante assumiu).
    Release(oneshot::Sender<()>),
}

/// O que outro participante precisa para assumir a mensagem (ids públicos; o token nunca sai da máquina).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffInfo {
    pub webhook_id: String,
    pub message_id: String,
    pub started: u64,
}

type Meta = Arc<Mutex<Option<(String, u64)>>>;

#[derive(Clone)]
pub struct DiscordSession {
    tx: mpsc::UnboundedSender<Cmd>,
    meta: Meta,
    webhook_id: String,
}

impl DiscordSession {
    pub fn spawn(client: DiscordClient, hook: Webhook, state_dir: PathBuf) -> Self {
        Self::start(client, hook, state_dir, None)
    }
    /// Assume uma mensagem que já existe (criada pelo dono anterior da sala).
    pub fn adopt(client: DiscordClient, hook: Webhook, state_dir: PathBuf, message_id: String, started: u64) -> Self {
        save_pending(&state_dir, &hook, &message_id);
        Self::start(client, hook, state_dir, Some((message_id, started)))
    }
    fn start(client: DiscordClient, hook: Webhook, state_dir: PathBuf, initial: Option<(String, u64)>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let meta: Meta = Arc::new(Mutex::new(initial.clone()));
        let webhook_id = hook.id.clone();
        tokio::spawn(session_loop(client, hook, state_dir, rx, initial, meta.clone()));
        Self { tx, meta, webhook_id }
    }
    /// Publica o aviso e devolve o id da mensagem.
    pub async fn announce(&self, a: Announcement) -> Result<String, DiscordError> {
        let (r, rx) = oneshot::channel();
        self.tx.send(Cmd::Announce(a, r)).map_err(|_| DiscordError::Gone)?;
        rx.await.map_err(|_| DiscordError::Gone)?
    }
    /// Agenda uma edição (agrupada com as seguintes).
    pub fn update(&self, a: Announcement) { let _ = self.tx.send(Cmd::Update(a)); }
    /// Remove o aviso e espera terminar.
    pub async fn end(&self) {
        let (r, rx) = oneshot::channel();
        if self.tx.send(Cmd::End(r)).is_ok() { let _ = rx.await; }
    }
    /// Passa a mensagem adiante sem apagá-la.
    pub async fn release(&self) {
        let (r, rx) = oneshot::channel();
        if self.tx.send(Cmd::Release(r)).is_ok() { let _ = rx.await; }
    }
    pub fn info(&self) -> Option<HandoffInfo> {
        self.meta.lock().ok().and_then(|g| g.clone()).map(|(message_id, started)| HandoffInfo { webhook_id: self.webhook_id.clone(), message_id, started })
    }
}

async fn session_loop(client: DiscordClient, hook: Webhook, dir: PathBuf, mut rx: mpsc::UnboundedReceiver<Cmd>, initial: Option<(String, u64)>, meta: Meta) {
    let (mut msg_id, mut started) = match initial { Some((m, s)) => (Some(m), s), None => (None, now_unix()) };
    let mut current = Announcement::default();
    let mut dirty = false;
    let mut last_edit = Instant::now() - MIN_EDIT_GAP;
    let set_meta = |v: Option<(String, u64)>| { if let Ok(mut g) = meta.lock() { *g = v; } };
    loop {
        let cmd = if dirty {
            let wait = MIN_EDIT_GAP.saturating_sub(last_edit.elapsed());
            match tokio::time::timeout(wait, rx.recv()).await {
                Ok(c) => c,
                Err(_) => {
                    if let Some(id) = &msg_id { let _ = client.update(&hook, id, &current, started).await; }
                    last_edit = Instant::now();
                    dirty = false;
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        match cmd {
            Some(Cmd::Announce(a, reply)) => {
                // no máximo um aviso ativo
                if let Some(old) = msg_id.take() { let _ = client.end(&hook, &old, &current.host).await; }
                started = now_unix();
                current = a;
                let r = client.announce(&hook, &current, started).await;
                if let Ok(id) = &r { msg_id = Some(id.clone()); save_pending(&dir, &hook, id); set_meta(Some((id.clone(), started))); }
                last_edit = Instant::now();
                dirty = false;
                let _ = reply.send(r);
            }
            Some(Cmd::Update(a)) => {
                if msg_id.is_none() { continue; }
                current = a;
                if last_edit.elapsed() >= MIN_EDIT_GAP {
                    if let Some(id) = &msg_id { let _ = client.update(&hook, id, &current, started).await; }
                    last_edit = Instant::now();
                } else {
                    dirty = true;
                }
            }
            Some(Cmd::Release(done)) => {
                set_meta(None);
                clear_pending(&dir);
                let _ = done.send(());
                return;
            }
            Some(Cmd::End(done)) => {
                if let Some(id) = msg_id.take() { let _ = client.end(&hook, &id, &current.host).await; }
                set_meta(None);
                clear_pending(&dir);
                let _ = done.send(());
                return;
            }
            None => {
                if let Some(id) = msg_id.take() { let _ = client.end(&hook, &id, &current.host).await; }
                set_meta(None);
                clear_pending(&dir);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "abcdefghijklmnopqrst_UVWXYZ-123";

    #[test]
    fn webhook_url_variants() {
        for u in [
            format!("https://discord.com/api/webhooks/123456789012345678/{TOKEN}"),
            format!("https://discordapp.com/api/v10/webhooks/123456789012345678/{TOKEN}"),
            format!("https://canary.discord.com/api/webhooks/123456789012345678/{TOKEN}"),
            format!("  https://ptb.discord.com/api/webhooks/123456789012345678/{TOKEN}  "),
        ] {
            let h = parse_webhook_url(&u).unwrap_or_else(|_| panic!("{u}"));
            assert_eq!(h.base, format!("https://discord.com/api/webhooks/123456789012345678/{TOKEN}"));
        }
        for u in [
            "http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrst",
            "https://evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrst",
            "https://discord.com.evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrst",
            "https://discord.com/api/webhooks/12/abcdefghijklmnopqrst",
            "https://discord.com/api/webhooks/123456789012345678/curto",
            "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrst/extra",
            "",
        ] {
            assert!(parse_webhook_url(u).is_err(), "{u}");
        }
    }

    fn ann() -> Announcement {
        Announcement { host: "Ana".into(), sources: vec!["🖥 Tela 1 + 🔊".into(), "📷 Câmera".into()], invite: "VB3.abc".into(), join_url: "https://x.github.io/join/#VB3.abc".into(), people: 3 }
    }

    #[test]
    fn live_payload_has_embed_link_code_and_no_mentions() {
        let p = build_payload(&ann(), true, 1_700_000_000).unwrap();
        assert_eq!(p["allowed_mentions"]["parse"], json!([]));
        let e = &p["embeds"][0];
        assert!(e["description"].as_str().unwrap().contains("[Entrar na sala](https://x.github.io/join/#VB3.abc)"));
        assert_eq!(e["url"], "https://x.github.io/join/#VB3.abc", "o título também é link");
        assert!(e["description"].as_str().unwrap().contains("<t:1700000000:R>"));
        assert!(e["fields"][1]["value"].as_str().unwrap().contains("VB3.abc"));
    }

    #[test]
    fn no_join_page_means_no_dead_link() {
        let mut a = ann();
        a.join_url.clear();
        let p = build_payload(&a, true, 1).unwrap();
        assert!(!p["embeds"][0]["description"].as_str().unwrap().contains("[Entrar na sala]("), "sem link morto");
    }

    #[test]
    fn thumbnail_comes_from_the_join_page_folder() {
        assert_eq!(page_base("https://u.github.io/repo/#VB3.abc").as_deref(), Some("https://u.github.io/repo/"));
        assert_eq!(page_base("https://u.github.io/repo#VB3.abc").as_deref(), Some("https://u.github.io/repo/"));
        assert_eq!(page_base("https://u.github.io/repo/index.html#x").as_deref(), Some("https://u.github.io/repo/"));
        assert_eq!(page_base("http://inseguro/#x"), None);
        let p = build_payload(&ann(), true, 1).unwrap();
        assert_eq!(p["embeds"][0]["thumbnail"]["url"], "https://x.github.io/join/logo.png");
        let mut a = ann();
        a.join_url.clear();
        assert!(build_payload(&a, true, 1).unwrap()["embeds"][0].get("thumbnail").is_none());
    }

    #[test]
    fn footer_shows_people_count_only_when_known() {
        let p = build_payload(&ann(), true, 1).unwrap();
        assert_eq!(p["embeds"][0]["footer"]["text"], "👥 3 na sala");
        let mut a = ann();
        a.people = 0;
        assert!(build_payload(&a, true, 1).unwrap()["embeds"][0].get("footer").is_none());
    }

    #[test]
    fn room_open_without_sources_is_green_and_has_no_sources_field() {
        let mut a = ann();
        a.sources.clear();
        let p = build_payload(&a, true, 1).unwrap();
        let e = &p["embeds"][0];
        assert_eq!(e["title"], "Sala aberta");
        assert_eq!(e["color"], 0x57F287);
        assert!(p["content"].as_str().unwrap().contains("abriu uma sala"));
        assert!(e["fields"].as_array().unwrap().iter().all(|f| f["name"] != "Fontes"));
    }

    #[test]
    fn ended_payload_clears_embeds() {
        let p = build_payload(&ann(), false, 0).unwrap();
        assert_eq!(p["embeds"], json!([]));
        assert!(p["content"].as_str().unwrap().contains("encerrada"));
    }

    #[test]
    fn names_cannot_inject_links_or_mentions() {
        let mut a = ann();
        a.host = "[clique](http://x) @everyone".into();
        let p = build_payload(&a, true, 1).unwrap();
        let c = p["content"].as_str().unwrap();
        assert!(c.contains("\\[clique\\]\\(http://x\\)") && c.contains("\\@everyone"));
    }

    #[test]
    fn long_source_lists_are_truncated_to_fit_the_field() {
        let mut a = ann();
        a.sources = (0..200).map(|i| format!("Fonte número {i}")).collect();
        let p = build_payload(&a, true, 1).unwrap();
        assert!(p["embeds"][0]["fields"][0]["value"].as_str().unwrap().chars().count() <= MAX_FIELD);
    }

    #[test]
    fn pending_file_holds_no_token() {
        let dir = std::env::temp_dir().join(format!("vbdc-{}", rand::random::<u32>()));
        let h = parse_webhook_url(&format!("https://discord.com/api/webhooks/123456789012345678/{TOKEN}")).unwrap();
        save_pending(&dir, &h, "987654321098765432");
        let t = std::fs::read_to_string(pending_file(&dir)).unwrap();
        assert!(!t.contains(TOKEN) && t.contains("987654321098765432"));
        clear_pending(&dir);
        assert!(!pending_file(&dir).exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
