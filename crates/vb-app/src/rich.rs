//! Rich Presence do Discord pelo soquete local (`\\.\pipe\discord-ipc-N`): publica a sala no seu perfil e recebe
//! quem entrou por ele. Só fala com o Discord instalado NESTE PC: nada de servidor, bot ou webhook.
//!
//! Quem pode "Entrar" é decidido pelas configurações de privacidade do Discord do dono (amigos e/ou participantes do
//! mesmo canal de voz). Pedidos de quem não tem permissão para entrar direto ("Pedir para entrar") são recusados aqui.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc;
use vb_core::rpc::{self, Incoming, RoomPresence};

/// ID público do aplicativo no Discord (portal de desenvolvedores). Não é segredo.
pub const APP_ID: &str = "1569675590787661944";
const RETRY: Duration = Duration::from_secs(15);

enum Cmd {
    Set(RoomPresence),
    Clear,
}

#[derive(Clone)]
pub struct Rich {
    tx: mpsc::UnboundedSender<Cmd>,
}

pub type OnJoin = Arc<dyn Fn(String) + Send + Sync>;
pub type OnLog = Arc<dyn Fn(&str, &str) + Send + Sync>;

impl Rich {
    /// Precisa de um runtime Tokio ativo. `on_join` recebe o código da sala de quem entrou pelo perfil.
    pub fn spawn(on_join: OnJoin, log: OnLog) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(rx, on_join, log));
        Self { tx }
    }
    pub fn set(&self, p: RoomPresence) { let _ = self.tx.send(Cmd::Set(p)); }
    pub fn clear(&self) { let _ = self.tx.send(Cmd::Clear); }
}

static NONCE: AtomicU64 = AtomicU64::new(1);
fn nonce() -> String { format!("vb-{}", NONCE.fetch_add(1, Ordering::Relaxed)) }

fn apply(want: &mut Option<RoomPresence>, cmd: Cmd) {
    match cmd {
        Cmd::Set(mut p) => {
            // `started` é do começo da sala, não de cada atualização
            p.started = match want { Some(w) if w.party_id == p.party_id => w.started, _ => rpc::now_unix_for_presence() };
            *want = Some(p);
        }
        Cmd::Clear => *want = None,
    }
}

async fn connect() -> Option<tokio::net::windows::named_pipe::NamedPipeClient> {
    // o Discord pode estar em qualquer discord-ipc-0..9 (Stable, Canary, PTB, instâncias duplicadas)
    for n in 0..10 {
        if let Ok(c) = ClientOptions::new().open(format!(r"\\.\pipe\discord-ipc-{n}")) {
            return Some(c);
        }
    }
    None
}

async fn run(mut rx: mpsc::UnboundedReceiver<Cmd>, on_join: OnJoin, log: OnLog) {
    let mut want: Option<RoomPresence> = None;
    loop {
        if let Some(pipe) = connect().await {
            log("info", "Discord IPC connected");
            if !session(pipe, &mut rx, &mut want, &on_join, &log).await {
                return; // o app está saindo
            }
            log("info", "Discord IPC disconnected");
        }
        // Discord fechado: tenta de novo daqui a pouco, sem deixar de anotar o que o app pede
        let wait = tokio::time::sleep(RETRY);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                c = rx.recv() => match c { Some(c) => apply(&mut want, c), None => return },
            }
        }
    }
}

/// Devolve `false` se o app está saindo (canal de comandos fechado); `true` se foi o Discord que desconectou.
async fn session(pipe: tokio::net::windows::named_pipe::NamedPipeClient, rx: &mut mpsc::UnboundedReceiver<Cmd>, want: &mut Option<RoomPresence>, on_join: &OnJoin, log: &OnLog) -> bool {
    let (mut rd, mut wr) = tokio::io::split(pipe);
    if wr.write_all(&rpc::encode_frame(rpc::OP_HANDSHAKE, &rpc::handshake(APP_ID))).await.is_err() {
        return true;
    }
    // leitor separado: `read_exact` não pode ser cancelado no meio de um `select!`
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<(u32, serde_json::Value)>();
    let reader = tokio::spawn(async move {
        loop {
            let mut h = [0u8; 8];
            if rd.read_exact(&mut h).await.is_err() { return; }
            let (op, len) = rpc::parse_header(&h);
            if len > rpc::MAX_FRAME { return; }
            let mut body = vec![0u8; len];
            if rd.read_exact(&mut body).await.is_err() { return; }
            let v = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
            if in_tx.send((op, v)).is_err() { return; }
        }
    });
    let pid = std::process::id();
    let mut ready = false;
    let alive = loop {
        tokio::select! {
            inc = in_rx.recv() => {
                let Some((op, v)) = inc else { break true };
                match op {
                    rpc::OP_CLOSE => break true,
                    rpc::OP_PING => { if wr.write_all(&rpc::encode_frame(rpc::OP_PONG, &v)).await.is_err() { break true; } }
                    _ => match rpc::parse_incoming(&v) {
                        Incoming::Ready => {
                            ready = true;
                            let mut out = rpc::encode_frame(rpc::OP_FRAME, &rpc::subscribe("ACTIVITY_JOIN", &nonce()));
                            out.extend(rpc::encode_frame(rpc::OP_FRAME, &rpc::subscribe("ACTIVITY_JOIN_REQUEST", &nonce())));
                            out.extend(rpc::encode_frame(rpc::OP_FRAME, &rpc::set_activity(pid, want.as_ref(), &nonce())));
                            if wr.write_all(&out).await.is_err() { break true; }
                        }
                        Incoming::Join(secret) => {
                            if rpc::join_secret_ok(&secret) { log("info", "Discord join received (opening room)"); on_join(secret); } else { log("warn", "Discord join secret rejected"); }
                        }
                        // quem não está no canal de voz (e só pede para entrar) não entra: recusa
                        Incoming::JoinRequest(user) => {
                            log("info", "Discord join request received; rejecting (only direct joins are allowed)");
                            if wr.write_all(&rpc::encode_frame(rpc::OP_FRAME, &rpc::reject_request(&user, &nonce()))).await.is_err() { break true; }
                        }
                        Incoming::Error { code, message } => log("warn", &format!("Discord IPC error {code}: {message}")),
                        Incoming::Other => {}
                    },
                }
            }
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break false };
                apply(want, cmd);
                if ready && wr.write_all(&rpc::encode_frame(rpc::OP_FRAME, &rpc::set_activity(pid, want.as_ref(), &nonce()))).await.is_err() { break true; }
            }
        }
    };
    reader.abort();
    alive
}
