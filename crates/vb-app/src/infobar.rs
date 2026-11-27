//! Esconde o aviso "vb.localhost está compartilhando sua tela — Parar compartilhamento | Ocultar" que o Chromium (WebView2)
//! mostra na parte de baixo da tela durante a transmissão.
//!
//! Não existe opção oficial nem flag para isso (a API `ScreenCaptureStarting` do WebView2 só permite cancelar ou adiar a captura).
//! O aviso é uma janela do Windows que pertence a um processo FILHO do nosso app (o WebView2 dele), então, enquanto há
//! transmissão, o app procura essas janelas e as oculta. A captura continua normalmente; o botão de parar do app e o ícone
//! vermelho da bandeja seguem mostrando que há transmissão.
//!
//! É um ajuste não documentado: se uma versão futura do WebView2 mudar o aviso, ele volta a aparecer e dá para desligar
//! em Configurações. O que foi encontrado fica no log (`Screen-capture notice …`), para facilitar o ajuste.
use crate::bridge::Shared;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE};

/// Host da nossa página (o Chromium escreve "<host> está compartilhando sua tela").
const ORIGIN_HOST: &str = "vb.localhost";
/// O aviso é uma faixa baixa; popups de permissão e outras janelas são mais altos.
const MAX_NOTICE_HEIGHT: i32 = 100;

/// Pura (testável): esta janela parece o aviso de compartilhamento?
pub fn is_notice(title: &str, height: i32) -> bool {
    height > 0 && height <= MAX_NOTICE_HEIGHT && title.to_lowercase().contains(ORIGIN_HOST)
}

/// `root` e todos os seus descendentes (o WebView2 roda em processos filhos do nosso).
fn family(root: u32) -> HashSet<u32> {
    let mut parent: HashMap<u32, u32> = HashMap::new();
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    parent.insert(e.th32ProcessID, e.th32ParentProcessID);
                    if Process32NextW(snap, &mut e).is_err() { break; }
                }
            }
            let _ = CloseHandle(snap);
        }
    }
    let mut out: HashSet<u32> = HashSet::from([root]);
    // varre até estabilizar (a árvore é rasa)
    for _ in 0..8 {
        let before = out.len();
        for (pid, par) in &parent {
            if out.contains(par) { out.insert(*pid); }
        }
        if out.len() == before { break; }
    }
    out
}

#[derive(Default)]
pub struct Scan {
    pub hidden: Vec<String>,
    pub seen: Vec<String>,
}

struct Ctx {
    family: HashSet<u32>,
    scan: Scan,
}

unsafe extern "system" fn on_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut Ctx);
    if !IsWindowVisible(hwnd).as_bool() { return BOOL(1); }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if !ctx.family.contains(&pid) { return BOOL(1); }
    let mut t = [0u16; 256];
    let n = GetWindowTextW(hwnd, &mut t).max(0) as usize;
    let title = String::from_utf16_lossy(&t[..n.min(t.len())]);
    let mut c = [0u16; 128];
    let m = GetClassNameW(hwnd, &mut c).max(0) as usize;
    let class = String::from_utf16_lossy(&c[..m.min(c.len())]);
    let mut r = RECT::default();
    let _ = GetWindowRect(hwnd, &mut r);
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    let label = format!("{class} | {title} | {w}x{h}");
    if is_notice(&title, h) {
        let _ = ShowWindow(hwnd, SW_HIDE);
        ctx.scan.hidden.push(label);
    } else if ctx.scan.seen.len() < 12 {
        ctx.scan.seen.push(label);
    }
    BOOL(1)
}

/// Uma passada: oculta o que parecer o aviso e devolve o que viu (para o log).
pub fn hide_notice(root: u32) -> Scan {
    let mut ctx = Ctx { family: family(root), scan: Scan::default() };
    unsafe {
        let _ = EnumWindows(Some(on_window), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.scan
}

/// Roda enquanto há transmissão (`Shared::live`). A janela do aviso aparece pouco depois do início, então varre a cada 0,4 s.
pub async fn watch(sh: Arc<Shared>) {
    let root = std::process::id();
    let (mut ticks, mut logged_hidden, mut logged_missing) = (0u32, false, false);
    while sh.live.load(Ordering::SeqCst) {
        let scan = tokio::task::spawn_blocking(move || hide_notice(root)).await.unwrap_or_default();
        ticks += 1;
        if !scan.hidden.is_empty() && !logged_hidden {
            logged_hidden = true;
            sh.log.info("Screen-capture notice hidden", Some(json!({ "windows": scan.hidden })));
        }
        if scan.hidden.is_empty() && !logged_hidden && !logged_missing && ticks == 12 {
            logged_missing = true; // ~5 s sem achar: registra as janelas visíveis para eu poder ajustar o critério
            sh.log.warn("Screen-capture notice not found", Some(json!({ "visibleWindows": scan.seen })));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_short_window_that_names_our_origin_is_the_notice() {
        assert!(is_notice("vb.localhost está compartilhando sua tela.", 44));
        assert!(is_notice("VB.LOCALHOST is sharing your screen", 60));
        assert!(!is_notice("vb.localhost quer usar a sua câmera", 180), "popup de permissão é mais alto");
        assert!(!is_notice("VideoBridge", 44), "a janela do app não");
        assert!(!is_notice("", 44));
        assert!(!is_notice("vb.localhost", 0));
    }
}
