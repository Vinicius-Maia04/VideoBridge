//! Laço de eventos: bandeja, atalhos globais, janela sob demanda e WebView2.
//! Em idle só existem a bandeja e o runtime (sem janela, sem captura, sem Chromium).
use crate::bridge::{emit, Shared, UserEvent};
use crate::{assets, platform, single};
use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget};
use tao::window::{Fullscreen, Window, WindowBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};
use wry::{WebContext, WebView, WebViewBuilder};
use wry::WebViewBuilderExtWindows;

const ORIGIN: &str = "https://vb.localhost/";
const BRIDGE_JS: &str = include_str!("bridge.js");
const TRAY: &[u8] = include_bytes!("../../../ui/assets/tray.png");
const TRAY_LIVE: &[u8] = include_bytes!("../../../ui/assets/tray-live.png");
/// Sem isto o Chromium reduz timers e renderização com a janela minimizada/oculta e a transmissão engasga.
const BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=msSmartScreenProtection";

fn icon(bytes: &[u8]) -> Icon {
    let img = image::load_from_memory(bytes).expect("ícone PNG embutido").into_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).expect("ícone válido")
}

struct Ui {
    window: Option<Window>,
    webview: Option<WebView>,
    ctx: WebContext,
    page_ready: bool,
    pending_invite: Option<String>,
    tray: Option<TrayIcon>,
    menu_open: Option<MenuId>,
    menu_stop: Option<MenuId>,
    menu_quit: Option<MenuId>,
    menu_update: Option<MenuId>,
    update: Option<(String, String)>,
    hotkeys: Option<GlobalHotKeyManager>,
    registered: HashMap<u32, &'static str>,
    keys: Vec<HotKey>,
}

impl Ui {
    fn js(&self, s: &str) {
        if let Some(w) = &self.webview {
            let _ = w.evaluate_script(s);
        }
    }

    fn open(&mut self, target: &EventLoopWindowTarget<UserEvent>, sh: &Arc<Shared>, invite: Option<String>) {
        if let Some(i) = invite { self.pending_invite = Some(i); }
        if let Some(w) = &self.window {
            w.set_visible(true);
            w.set_focus();
            if self.page_ready { self.flush_invite(); }
            return;
        }
        let window = match WindowBuilder::new().with_title("VideoBridge").with_inner_size(LogicalSize::new(1280.0, 780.0)).with_min_inner_size(LogicalSize::new(900.0, 560.0)).build(target) {
            Ok(w) => w,
            Err(e) => { sh.log.error("Falha ao criar a janela", Some(json!({"error": e.to_string()}))); return; }
        };
        self.page_ready = false;
        let (p_ipc, p_load, sh_ipc, handle) = (sh.proxy.clone(), sh.proxy.clone(), sh.clone(), tokio::runtime::Handle::current());
        let built = WebViewBuilder::with_web_context(&mut self.ctx)
            .with_custom_protocol("vb".into(), move |_id, req| assets::respond(req))
            .with_https_scheme(true)
            .with_url(ORIGIN.to_string() + "room.html")
            .with_initialization_script(BRIDGE_JS)
            .with_background_color((15, 16, 20, 255))
            .with_additional_browser_args(BROWSER_ARGS)
            .with_navigation_handler(|u| u.starts_with(ORIGIN))
            .with_new_window_req_handler(|_| false)
            .with_on_page_load_handler(move |ev, _| { if matches!(ev, wry::PageLoadEvent::Finished) { let _ = p_load.send_event(UserEvent::PageLoaded); } })
            .with_ipc_handler(move |req: wry::http::Request<String>| {
                // só a nossa própria página fala com o processo principal
                if req.uri().host() != Some("vb.localhost") { return; }
                let Ok(m) = serde_json::from_str::<Value>(req.body()) else { return };
                let ch = m["ch"].as_str().unwrap_or("").to_string();
                let args = m["args"].as_array().cloned().unwrap_or_default();
                match m["id"].as_u64() {
                    None => sh_ipc.handle_send(&ch, &args),
                    Some(id) => {
                        let (sh, proxy) = (sh_ipc.clone(), p_ipc.clone());
                        handle.spawn(async move {
                            let (ok, v) = match sh.handle(&ch, args).await { Ok(v) => (true, v), Err(e) => (false, Value::String(e)) };
                            let _ = proxy.send_event(UserEvent::Reply { id, ok, json: v.to_string() });
                        });
                    }
                }
            })
            .build(&window);
        match built {
            Ok(wv) => {
                #[cfg(feature = "auto-permissions")]
                allow_media_permissions(&wv);
                watch_fullscreen(&wv, sh.proxy.clone());
                self.webview = Some(wv);
                self.window = Some(window);
            }
            Err(e) => sh.log.error("Falha ao criar o WebView2 (o runtime está instalado?)", Some(json!({"error": e.to_string()}))),
        }
    }

    fn announce_update(&self) {
        if let Some((tag, url)) = &self.update {
            self.js(&emit("update:available", &json!({"tag": tag, "url": url})));
        }
    }

    fn flush_invite(&mut self) {
        if let Some(code) = self.pending_invite.take() {
            self.js(&emit("room:invite", &json!(code)));
        }
    }

    /// Fechar a janela destrói WebView2 (captura, encoder, conexões); o Rust avisa a sala.
    fn close_window(&mut self, sh: &Arc<Shared>) {
        self.webview = None;
        self.window = None;
        self.page_ready = false;
        self.refresh_tray(false);
        let sh = sh.clone();
        tokio::spawn(async move { sh.on_window_closed().await });
    }

    fn build_tray(&mut self) {
        self.refresh_tray(false);
    }

    fn refresh_tray(&mut self, live: bool) {
        let status = MenuItem::new(if live { "🔴 Compartilhando" } else { "● Pronto" }, false, None);
        let open = MenuItem::new("Abrir VideoBridge", true, None);
        let stop = MenuItem::new("Parar compartilhamento", true, None);
        let quit = MenuItem::new("Sair", true, None);
        let upd = self.update.as_ref().map(|(tag, _)| MenuItem::new(format!("⬆ Nova versão {tag} — baixar"), true, None));
        let menu = Menu::new();
        let _ = menu.append(&status);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&open);
        if live { let _ = menu.append(&stop); }
        if let Some(u) = &upd { let _ = menu.append(u); }
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&quit);
        (self.menu_open, self.menu_stop, self.menu_quit) = (Some(open.id().clone()), Some(stop.id().clone()), Some(quit.id().clone()));
        self.menu_update = upd.as_ref().map(|u| u.id().clone());
        let tip = if live { "VideoBridge — 🔴 Compartilhando" } else { "VideoBridge — Pronto" };
        let ic = icon(if live { TRAY_LIVE } else { TRAY });
        match &self.tray {
            Some(t) => {
                let _ = t.set_icon(Some(ic));
                let _ = t.set_tooltip(Some(tip));
                t.set_menu(Some(Box::new(menu)));
            }
            None => self.tray = TrayIconBuilder::new().with_icon(ic).with_tooltip(tip).with_menu(Box::new(menu)).build().ok(),
        }
    }

    fn register_hotkeys(&mut self, sh: &Arc<Shared>) {
        let mgr = self.hotkeys.get_or_insert_with(|| GlobalHotKeyManager::new().expect("gerenciador de atalhos"));
        for k in self.keys.drain(..) {
            let _ = mgr.unregister(k);
        }
        self.registered.clear();
        let hk = sh.config().hotkeys;
        for (accel, name) in [(hk.toggle_stream, "toggleStream"), (hk.toggle_camera, "toggleCamera"), (hk.toggle_mic, "toggleMic")] {
            match HotKey::from_str(&accel) {
                Ok(h) => match mgr.register(h) {
                    Ok(()) => { self.registered.insert(h.id(), name); self.keys.push(h); }
                    Err(_) => sh.log.warn("Hotkey indisponível", Some(json!({"accel": accel}))),
                },
                Err(_) => sh.log.warn("Hotkey inválida", Some(json!({"accel": accel}))),
            }
        }
    }
}

/// `element.requestFullscreen()` no WebView2 só estica o elemento até as bordas da página; quem põe a JANELA em tela
/// cheia é o aplicativo hospedeiro, ao ouvir este evento (o Electron fazia isso sozinho).
fn watch_fullscreen(wv: &WebView, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
    use webview2_com::ContainsFullScreenElementChangedEventHandler;
    use wry::WebViewExtWindows;
    let Ok(core) = (unsafe { wv.controller().CoreWebView2() }) else { return };
    let core2 = core.clone();
    let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |_, _| {
        let mut on = windows::Win32::Foundation::BOOL(0);
        unsafe { core2.ContainsFullScreenElement(&mut on)?; }
        let _ = proxy.send_event(UserEvent::Fullscreen(on.as_bool()));
        Ok(())
    }));
    let mut token = Default::default();
    unsafe { let _ = core.add_ContainsFullScreenElementChanged(&handler, &mut token); }
}

#[cfg(feature = "auto-permissions")]
fn allow_media_permissions(wv: &WebView) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::PermissionRequestedEventHandler;
    use wry::WebViewExtWindows;
    let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            let (mut kind, mut uri) = (COREWEBVIEW2_PERMISSION_KIND(0), windows::core::PWSTR::null());
            unsafe {
                args.PermissionKind(&mut kind)?;
                args.Uri(&mut uri)?;
                let ours = uri.to_string().map(|u| u.starts_with(ORIGIN)).unwrap_or(false);
                let media = kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA;
                args.SetState(if ours && media { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })?;
            }
        }
        Ok(())
    }));
    let mut token = Default::default();
    if let Ok(core) = unsafe { wv.controller().CoreWebView2() } {
        unsafe { let _ = core.add_PermissionRequested(&handler, &mut token); }
    }
}

pub fn run() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
    let url_arg = std::env::args().skip(1).find(|a| a.to_lowercase().starts_with("videobridge://"));
    let hidden_flag = std::env::args().any(|a| a == "--hidden");

    // instância única: a segunda só entrega o link à primeira e sai
    let claim = { let _g = rt.enter(); single::claim() };
    let server = match claim {
        single::Claim::Secondary => { let _ = single::forward(url_arg.as_deref().unwrap_or("open")); return; }
        single::Claim::Primary(s) => s,
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let _g = rt.enter();
    {
        let p = proxy.clone();
        rt.spawn(single::serve(server, move |s| { let _ = p.send_event(UserEvent::Open((s != "open").then_some(s))); }));
    }

    let dir = vb_core::config::default_dir();
    let sh = Shared::new(dir.clone(), proxy.clone());
    sh.log.info("VideoBridge started (idle)", Some(json!({"version": env!("CARGO_PKG_VERSION")})));
    platform::register_protocol();
    platform::set_autostart(sh.config().autostart);
    { let s = sh.clone(); rt.spawn(async move { s.startup_cleanup().await }); }
    { let s = sh.clone(); rt.spawn(async move { s.update_loop().await }); }
    { let p = proxy.clone(); MenuEvent::set_event_handler(Some(move |e: MenuEvent| { let _ = p.send_event(UserEvent::Menu(e.id)); })); }
    { let p = proxy.clone(); GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| { if e.state == HotKeyState::Pressed { let _ = p.send_event(UserEvent::HotKey(e.id)); } })); }
    {
        let p = proxy.clone();
        TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| {
            if let TrayIconEvent::Click { button: tray_icon::MouseButton::Left, button_state: tray_icon::MouseButtonState::Up, .. } = e {
                let _ = p.send_event(UserEvent::Open(None));
            }
        }));
    }

    let start_hidden = hidden_flag && sh.config().start_minimized;
    let mut ui = Ui { window: None, webview: None, ctx: WebContext::new(Some(dir.join("webview"))), page_ready: false, pending_invite: None, tray: None, menu_open: None, menu_stop: None, menu_quit: None, menu_update: None, update: None, hotkeys: None, registered: HashMap::new(), keys: Vec::new() };
    let mut first_url = url_arg;

    event_loop.run(move |event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                ui.build_tray();
                ui.register_hotkeys(&sh);
                if first_url.is_some() || !start_hidden { ui.open(target, &sh, first_url.take()); }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => ui.close_window(&sh),
            Event::UserEvent(ue) => match ue {
                UserEvent::Open(url) => ui.open(target, &sh, url),
                UserEvent::Js(s) => ui.js(&s),
                UserEvent::Reply { id, ok, json } => ui.js(&format!("window.__vb&&window.__vb.resolve({id},{ok},{json});")),
                UserEvent::StreamState(live) => ui.refresh_tray(live),
                UserEvent::ReloadHotkeys => ui.register_hotkeys(&sh),
                UserEvent::Fullscreen(on) => { if let Some(w) = &ui.window { w.set_fullscreen(on.then_some(Fullscreen::Borderless(None))); } }
                UserEvent::PageLoaded => { ui.page_ready = true; ui.flush_invite(); ui.announce_update(); }
                UserEvent::UpdateAvailable(tag, url) => { ui.update = Some((tag, url)); ui.refresh_tray(sh.live.load(std::sync::atomic::Ordering::SeqCst)); ui.announce_update(); }
                UserEvent::Menu(id) => {
                    if Some(&id) == ui.menu_open.as_ref() { ui.open(target, &sh, None); }
                    else if Some(&id) == ui.menu_stop.as_ref() { ui.js(&emit("hotkey", &json!("stopShare"))); }
                    else if Some(&id) == ui.menu_update.as_ref() {
                        // só abre links do próprio GitHub (o do release que veio da API)
                        if let Some((_, url)) = ui.update.as_ref().filter(|(_, u)| u.starts_with("https://github.com/")) {
                            let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
                        }
                    }
                    else if Some(&id) == ui.menu_quit.as_ref() {
                        // despede-se da sala e apaga o aviso do Discord antes de sair (no máximo 3 s)
                        let s = sh.clone();
                        let _ = tokio::runtime::Handle::current().block_on(async { tokio::time::timeout(std::time::Duration::from_secs(3), s.on_window_closed()).await });
                        *flow = ControlFlow::Exit;
                    }
                }
                UserEvent::HotKey(id) => {
                    if let Some(name) = ui.registered.get(&id).copied() {
                        if ui.window.is_none() && name == "toggleStream" { ui.open(target, &sh, None); } else { ui.js(&emit("hotkey", &json!(name))); }
                    }
                }
            },
            _ => {}
        }
    });
}
