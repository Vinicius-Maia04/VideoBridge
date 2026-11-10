//! Instância única, sem porta de rede: um *named pipe* local (`\\.\pipe\…`) que também leva o link
//! `videobridge://…` da segunda instância para a primeira.
use std::io::Write;
use tokio::io::AsyncReadExt;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

const PIPE: &str = r"\\.\pipe\videobridge-single-instance-v1";

pub enum Claim {
    Primary(NamedPipeServer),
    Secondary,
}

/// `first_pipe_instance(true)` falha se o pipe já existe: isso funciona como a trava de instância única.
/// Precisa ser chamado com um runtime Tokio ativo (`runtime.enter()`).
pub fn claim() -> Claim {
    match ServerOptions::new().first_pipe_instance(true).create(PIPE) {
        Ok(s) => Claim::Primary(s),
        Err(_) => Claim::Secondary,
    }
}

/// Segunda instância: entrega o argumento (ou "open") à primeira.
pub fn forward(arg: &str) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).open(PIPE)?;
    f.write_all(arg.as_bytes())
}

pub async fn serve(mut server: NamedPipeServer, on_message: impl Fn(String) + Send + 'static) {
    loop {
        if server.connect().await.is_err() {
            return;
        }
        let Ok(next) = ServerOptions::new().create(PIPE) else { return };
        let mut done = std::mem::replace(&mut server, next);
        let mut buf = Vec::new();
        // a linha é curta; limita para um cliente mal-educado não encher a memória
        let _ = (&mut done).take(8192).read_to_end(&mut buf).await;
        if let Ok(s) = String::from_utf8(buf) {
            on_message(s.trim().to_string());
        }
    }
}
