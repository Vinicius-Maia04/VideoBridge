//! VideoBridge — shell nativo em Rust.
//!
//! O que é Rust aqui: processo principal, bandeja, atalhos globais, instância única, protocolo
//! `videobridge://`, configuração, sinalização cifrada, Discord e o áudio por aplicativo.
//! O que continua sendo do WebView2 (o Chromium que já vem no Windows): captura de tela/câmera,
//! encoder H.264 por hardware, WebRTC (controle de congestionamento, jitter buffer) e a interface.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod app;
#[cfg(windows)]
mod assets;
#[cfg(windows)]
mod bridge;
#[cfg(windows)]
mod platform;
#[cfg(windows)]
mod rich;
#[cfg(windows)]
mod single;

#[cfg(windows)]
fn main() {
    app::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("O VideoBridge é um aplicativo para Windows. Para rodar os testes portáteis: cargo test -p vb-core -p vb-audio");
}
