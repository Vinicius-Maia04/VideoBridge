//! Estado compartilhado e despacho dos comandos vindos da interface (mesmos canais do antigo main.js).
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tao::event_loop::EventLoopProxy;
use vb_audio::{Event as AudioEvent, Policy};
use vb_core::config::{self, Config};
use vb_core::discord::{self, Announcement, DiscordClient, DiscordSession};
use vb_core::logger::Logger;
use vb_core::relay::{self, Event as RelayEvent, Relay, RelayConfig};
use vb_core::room;

pub enum UserEvent {
    Open(Option<String>),
    /// Script a executar na página (emitido de qualquer thread; só a thread principal toca no WebView).
    Js(String),
    Reply { id: u64, ok: bool, json: String },
    StreamState(bool),
    ReloadHotkeys,
    PageLoaded,
    /// Um elemento da página entrou/saiu da tela cheia (o WebView2 pede que a JANELA acompanhe).
    Fullscreen(bool),
    /// Há versão nova no GitHub: (tag, url do release).
    UpdateAvailable(String, String),
    Menu(tray_icon::menu::MenuId),
    HotKey(u32),
}

struct Session {
    relay: Arc<Relay>,
    alone: bool,
}

pub struct Shared {
    pub cfg: Mutex<Config>,
    pub cfg_file: PathBuf,
    pub dir: PathBuf,
    pub log: Logger,
    pub proxy: EventLoopProxy<UserEvent>,
    pub live: AtomicBool,
    session: Mutex<Option<Session>>,
    discord: Mutex<Option<DiscordSession>>,
    discord_client: DiscordClient,
    audio: Arc<Mutex<vb_audio::Service>>,
}

pub fn emit(ch: &str, payload: &Value) -> String {
    format!("window.__vb&&window.__vb.emit({},{});", json!(ch), payload)
}

fn valid_peer_id(s: &str) -> bool {
    (6..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn announcement(v: &Value) -> Announcement {
    Announcement {
        host: v["host"].as_str().unwrap_or("").chars().take(64).collect(),
        sources: v["sources"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.chars().take(120).collect())).take(20).collect()).unwrap_or_default(),
        invite: v["invite"].as_str().unwrap_or("").into(),
        join_url: v["joinUrl"].as_str().filter(|u| u.starts_with("https://")).unwrap_or("").into(),
        people: v["people"].as_u64().unwrap_or(0).min(99) as u32,
    }
}

impl Shared {
    pub fn new(dir: PathBuf, proxy: EventLoopProxy<UserEvent>) -> Arc<Self> {
        let cfg_file = dir.join("config.json");
        Arc::new(Self {
            cfg: Mutex::new(config::load(&cfg_file)),
            cfg_file,
            log: Logger::new(Some(dir.join("logs").join("videobridge.log"))),
            dir,
            proxy,
            live: AtomicBool::new(false),
            session: Mutex::new(None),
            discord: Mutex::new(None),
            discord_client: DiscordClient::new(),
            audio: Arc::new(Mutex::new(vb_audio::Service::new())),
        })
    }

    pub fn config(&self) -> Config { self.cfg.lock().expect("cfg").clone() }
    fn js(&self, s: String) { let _ = self.proxy.send_event(UserEvent::Js(s)); }

    /// Consulta os releases do GitHub: 15 s depois de abrir e a cada 6 h. Só avisa (uma vez por versão).
    pub async fn update_loop(self: Arc<Self>) {
        let Some(repo) = option_env!("VB_REPO") else { return }; // build local: sem verificação
        let client = relay::http_client();
        let mut notified = String::new();
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            match vb_core::update::check(&client, repo, env!("CARGO_PKG_VERSION")).await {
                Ok(Some(r)) if r.tag != notified => {
                    self.log.info("Update available", Some(json!({"tag": r.tag})));
                    notified = r.tag.clone();
                    let _ = self.proxy.send_event(UserEvent::UpdateAvailable(r.tag, r.url));
                }
                Ok(_) => {}
                Err(e) => self.log.warn("Update check failed", Some(json!({"error": e}))),
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    }

    /// Ao iniciar: apaga o aviso de uma sessão anterior que não chegou a se despedir.
    pub async fn startup_cleanup(self: &Arc<Self>) {
        let url = self.config().discord.webhook_url;
        if !url.is_empty() {
            discord::cleanup_orphan(&self.discord_client, &url, &self.dir).await;
        }
    }

    /// A janela fechou (ou o app vai sair): avisa a sala, solta o relay, apaga o aviso do Discord, para o áudio.
    pub async fn on_window_closed(self: &Arc<Self>) {
        self.live.store(false, Ordering::SeqCst);
        self.close_session(true);
        let me = self.clone();
        let _ = tokio::task::spawn_blocking(move || { if let Ok(mut a) = me.audio.lock() { a.stop(); } }).await;
        self.end_discord().await;
        self.log.info("Window closed; engine released", None);
    }

    fn close_session(&self, say_bye: bool) {
        let Some(s) = self.session.lock().expect("session").take() else { return };
        if say_bye {
            let relay = s.relay.clone();
            let t = if s.alone { "closed" } else { "bye" };
            tokio::spawn(async move {
                let _ = relay.publish(json!({ "t": t })).await;
                tokio::time::sleep(Duration::from_millis(1500)).await;
                relay.close();
            });
        } else {
            s.relay.close();
        }
    }

    async fn end_discord(&self) {
        let s = self.discord.lock().expect("discord").take();
        if let Some(s) = s {
            s.end().await;
            self.log.info("Discord announcement removed", None);
        }
    }

    fn open_session(self: &Arc<Self>, code: Option<&str>, peer_id: &str) -> Result<Value, String> {
        let cfg = self.config();
        let created = code.is_none();
        let (secret, relay_url) = match code {
            Some(c) => {
                let p = room::parse_code(c).map_err(|e| e.to_string())?;
                (p.secret, p.relay.unwrap_or(cfg.signaling.relay.clone()))
            }
            None => (room::new_secret(), cfg.signaling.relay.clone()),
        };
        self.close_session(false);
        let (relay, mut rx) = Relay::start(RelayConfig { relay: relay_url.clone(), secret: secret.clone(), role: peer_id.into(), skip_history: true });
        *self.session.lock().expect("session") = Some(Session { relay, alone: true });
        let me = self.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                match ev {
                    RelayEvent::Message(m) => me.js(emit("sig:message", &m)),
                    RelayEvent::Status { state, error } => {
                        me.log.info("Relay status", Some(json!({"state": state.as_str(), "error": error})));
                        me.js(emit("sig:status", &json!({"state": state.as_str(), "error": error})));
                    }
                }
            }
        });
        let code = room::make_code(&secret, &relay_url).map_err(|e| e.to_string())?;
        let jp = cfg.discord.join_page_url;
        self.log.info("Room opened", Some(json!({"relay": relay_url, "created": created})));
        Ok(json!({ "code": code, "joinUrl": if jp.is_empty() { String::new() } else { format!("{jp}#{code}") } }))
    }

    /// Canais que não esperam resposta (antigo `ipcRenderer.send`).
    pub fn handle_send(self: &Arc<Self>, ch: &str, args: &[Value]) {
        match ch {
            "room:alone" => {
                if let Some(s) = self.session.lock().expect("session").as_mut() { s.alone = args.first().and_then(Value::as_bool).unwrap_or(false); }
            }
            "stream:state" => {
                let live = args.first().and_then(Value::as_str) == Some("STREAMING");
                self.live.store(live, Ordering::SeqCst);
                let _ = self.proxy.send_event(UserEvent::StreamState(live));
                self.log.info("Share state", Some(json!({"state": if live {"STREAMING"} else {"IDLE"}})));
            }
            "log" => {
                let level = args.first().and_then(Value::as_str).unwrap_or("info");
                let msg: String = args.get(1).and_then(Value::as_str).unwrap_or("").chars().take(300).collect();
                let extra = args.get(2).filter(|v| v.is_object()).cloned();
                match level { "error" => self.log.error(&msg, extra), "warn" => self.log.warn(&msg, extra), _ => self.log.info(&msg, extra) }
            }
            _ => {}
        }
    }

    /// Canais com resposta (antigo `ipcMain.handle`).
    pub async fn handle(self: &Arc<Self>, ch: &str, args: Vec<Value>) -> Result<Value, String> {
        let a0 = args.first().cloned().unwrap_or(Value::Null);
        match ch {
            // O seletor de tela é do WebView2; estes canais existem só por compatibilidade com a interface.
            "sources:list" => Ok(json!([])),
            "capture:select" => Ok(json!(true)),
            "config:get" => Ok(serde_json::to_value(self.config()).map_err(|e| e.to_string())?),
            "config:set" => {
                let saved = config::save(&self.cfg_file, &a0).map_err(|e| e.to_string())?;
                crate::platform::set_autostart(saved.autostart);
                *self.cfg.lock().expect("cfg") = saved.clone();
                let _ = self.proxy.send_event(UserEvent::ReloadHotkeys);
                Ok(serde_json::to_value(saved).map_err(|e| e.to_string())?)
            }
            "discord:announce" => {
                let cfg = self.config();
                if !cfg.discord.announce || cfg.discord.webhook_url.is_empty() { return Ok(Value::Null); }
                self.end_discord().await; // no máximo um aviso ativo
                let hook = discord::parse_webhook_url(&cfg.discord.webhook_url).map_err(|e| e.to_string())?;
                let sess = DiscordSession::spawn(self.discord_client.clone(), hook, self.dir.clone());
                let id = sess.announce(announcement(&a0)).await.map_err(|e| e.to_string())?;
                *self.discord.lock().expect("discord") = Some(sess);
                Ok(json!(id))
            }
            "discord:update" => {
                let s = self.discord.lock().expect("discord").clone();
                match s { Some(s) => { s.update(announcement(&a0)); Ok(json!(true)) } None => Ok(Value::Null) }
            }
            "discord:end" => { self.end_discord().await; Ok(Value::Null) }
            // Passagem de bastão: o dono da mensagem vai sair e a sala continua.
            "discord:handoffInfo" => {
                let s = self.discord.lock().expect("discord").clone();
                Ok(s.and_then(|s| s.info()).map(|i| json!({"webhookId": i.webhook_id, "messageId": i.message_id, "started": i.started})).unwrap_or(Value::Null))
            }
            "discord:adopt" => {
                let cfg = self.config();
                if !cfg.discord.announce || cfg.discord.webhook_url.is_empty() { return Ok(json!(false)); }
                let hook = discord::parse_webhook_url(&cfg.discord.webhook_url).map_err(|e| e.to_string())?;
                let mid = a0["messageId"].as_str().filter(|m| !m.is_empty() && m.len() <= 25 && m.bytes().all(|c| c.is_ascii_digit()));
                // só assume se o webhook configurado AQUI é o mesmo da mensagem (senão não conseguiria editá-la)
                let (Some(mid), true) = (mid, a0["webhookId"].as_str() == Some(hook.id.as_str())) else { return Ok(json!(false)) };
                self.end_discord().await;
                let sess = DiscordSession::adopt(self.discord_client.clone(), hook, self.dir.clone(), mid.to_string(), a0["started"].as_u64().unwrap_or_else(discord::now_unix));
                sess.update(announcement(&a0));
                *self.discord.lock().expect("discord") = Some(sess);
                self.log.info("Discord announcement adopted", None);
                Ok(json!(true))
            }
            "discord:release" => {
                let s = self.discord.lock().expect("discord").take();
                if let Some(s) = s { s.release().await; }
                Ok(Value::Null)
            }
            "sig:open" => {
                let peer = args.get(1).and_then(Value::as_str).unwrap_or("");
                if !valid_peer_id(peer) { return Err("Identificador de participante inválido.".into()); }
                self.open_session(a0.as_str().filter(|s| !s.is_empty()), peer)
            }
            "sig:send" => {
                let relay = self.session.lock().expect("session").as_ref().map(|s| s.relay.clone()).ok_or("Sinalização não está aberta.")?;
                let ok = a0.get("t").and_then(Value::as_str).map_or(false, |t| !t.starts_with('_')) && a0.to_string().len() <= 200_000;
                if !ok { return Err("Mensagem de sinalização inválida.".into()); }
                relay.publish(a0).await.map_err(|e| e.to_string())?;
                Ok(json!(true))
            }
            "sig:close" => { self.close_session(false); Ok(json!(true)) }
            "sig:selfTest" => Ok(serde_json::to_value(relay::self_test(&self.config().signaling.relay).await).map_err(|e| e.to_string())?),
            "appaudio:status" => Ok(serde_json::to_value(self.audio.lock().expect("audio").status()).map_err(|e| e.to_string())?),
            "appaudio:list" => {
                let (audio, policy) = (self.audio.clone(), Policy::from_json(&a0));
                let apps = tokio::task::spawn_blocking(move || audio.lock().expect("audio").list(std::process::id(), &policy)).await.map_err(|e| e.to_string())??;
                Ok(json!({ "apps": apps }))
            }
            "appaudio:start" => {
                let (audio, policy, me) = (self.audio.clone(), Policy::from_json(&a0), self.clone());
                let fmt = tokio::task::spawn_blocking(move || {
                    let pcm_me = me.clone();
                    let buf = Mutex::new(Vec::<u8>::with_capacity(8192));
                    // junta ~20 ms de áudio por mensagem (mixer emite blocos menores): menos mensagens para a página
                    let pcm: vb_audio::PcmSink = Arc::new(move |b: &[i16]| {
                        let mut g = buf.lock().expect("pcm");
                        g.extend(b.iter().flat_map(|s| s.to_le_bytes()));
                        if g.len() >= 3840 {
                            use base64::Engine;
                            let s = base64::engine::general_purpose::STANDARD.encode(&*g);
                            g.clear();
                            pcm_me.js(format!("window.__vb&&window.__vb.pcm(\"{s}\");"));
                        }
                    });
                    let ev_me = me.clone();
                    let events: vb_audio::EventSink = Arc::new(move |ev: AudioEvent| {
                        match &ev {
                            AudioEvent::CaptureError { app, message } => ev_me.log.warn("Audio helper event", Some(json!({"event": "capture_error", "app": app, "message": message}))),
                            AudioEvent::ScanError(m) => ev_me.log.warn("Audio helper event", Some(json!({"event": "scan_error", "message": m}))),
                            _ => {}
                        }
                        ev_me.js(emit("appaudio:event", &ev.to_json()));
                    });
                    audio.lock().expect("audio").start(policy, std::process::id(), pcm, events)
                })
                .await
                .map_err(|e| e.to_string())??;
                self.log.info("Per-app audio started", Some(serde_json::to_value(&fmt).unwrap_or_default()));
                Ok(serde_json::to_value(fmt).map_err(|e| e.to_string())?)
            }
            "appaudio:update" => Ok(json!(self.audio.lock().expect("audio").update(Policy::from_json(&a0)))),
            "appaudio:stop" => {
                let audio = self.audio.clone();
                tokio::task::spawn_blocking(move || audio.lock().expect("audio").stop()).await.map_err(|e| e.to_string())?;
                Ok(json!(true))
            }
            "appaudio:test" => {
                let audio = self.audio.clone();
                let r = tokio::task::spawn_blocking(move || -> Value {
                    let svc = audio.lock().expect("audio");
                    let apps = match svc.list(std::process::id(), &Policy::from_json(&json!({}))) { Ok(a) => a, Err(e) => return json!({"ok": false, "error": e}) };
                    let Some(t) = apps.iter().find(|a| a.active).or(apps.first()) else { return json!({"ok": false, "none": true, "error": "nenhum aplicativo com áudio aberto para testar"}) };
                    let r = svc.capture_test(t.pid, 2);
                    let mut v = serde_json::to_value(&r).unwrap_or_default();
                    v["app"] = json!(t.name);
                    if !r.ok {
                        v["probe"] = json!(svc.probe(t.pid).iter().map(|p| format!("{} → {}{}", p.name, p.hr, if p.ok { " (FUNCIONOU)" } else { "" })).collect::<Vec<_>>());
                    }
                    v
                })
                .await
                .map_err(|e| e.to_string())?;
                Ok(r)
            }
            "clipboard:write" => {
                let text = a0.as_str().unwrap_or("").to_string();
                tokio::task::spawn_blocking(move || arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())??;
                Ok(json!(true))
            }
            "app:version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
            _ => Err(format!("canal desconhecido: {ch}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_ids() {
        assert!(valid_peer_id("abc123_-XYZ"));
        assert!(!valid_peer_id("curto") && !valid_peer_id("tem espaço!") && !valid_peer_id(&"a".repeat(33)));
    }
    #[test]
    fn announcement_rejects_non_https_join_links_and_caps_lists() {
        let a = announcement(&json!({"host":"Ana","sources":["a";50],"invite":"VB3.x","joinUrl":"javascript:alert(1)","people":500}));
        assert_eq!(a.people, 99);
        assert_eq!(a.join_url, "");
        assert_eq!(a.sources.len(), 20);
    }
}
