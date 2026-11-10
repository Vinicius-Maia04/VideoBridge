//! Serviço de áudio por aplicativo: varre os aplicativos, liga/desliga as capturas conforme a política,
//! mixa tudo num relógio único e entrega o PCM por callback.
mod apps;
mod capture;
mod hr;

use crate::mixer::{self, RingMap};
use crate::{AppInfo, Event, EventSink, Format, PcmSink, Policy, ProbeRow, Status, TestResult};
use capture::{Capture, ComGuard};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MIN_BUILD: u32 = 19041; // Windows 10 2004
const SCAN_EVERY: Duration = Duration::from_millis(750);
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(5);
/// Chave da captura única do modo "tudo menos o VideoBridge".
const ALL_KEY: &str = "*";

#[repr(C)]
struct OsVersionInfoW {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform: u32,
    csd: [u16; 128],
}
#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
}

fn windows_build() -> Option<u32> {
    let mut v = OsVersionInfoW { size: std::mem::size_of::<OsVersionInfoW>() as u32, major: 0, minor: 0, build: 0, platform: 0, csd: [0; 128] };
    (unsafe { RtlGetVersion(&mut v) } == 0).then_some(v.build)
}

struct Running {
    stop: Arc<AtomicBool>,
    policy: Arc<Mutex<Policy>>,
    wake: mpsc::Sender<()>,
    threads: Vec<JoinHandle<()>>,
}

#[derive(Default)]
pub struct Service {
    running: Option<Running>,
}

impl Service {
    pub fn new() -> Self { Self::default() }

    pub fn status(&self) -> Status {
        match windows_build() {
            Some(b) if b >= MIN_BUILD => Status { supported: true, reason: None, build: Some(b) },
            Some(b) => Status { supported: false, reason: Some(format!("Requer Windows 10 versão 2004 (build {MIN_BUILD}) ou mais novo; este PC está na build {b}.")), build: Some(b) },
            None => Status { supported: false, reason: Some("não foi possível ler a versão do Windows".into()), build: None },
        }
    }

    pub fn list(&self, self_pid: u32, policy: &Policy) -> Result<Vec<AppInfo>, String> {
        let _com = ComGuard::init();
        let mut apps = apps::scan(self_pid)?.apps;
        for a in &mut apps {
            a.included = policy.included(&a.key);
        }
        Ok(apps)
    }

    /// Inicia a captura e a mixagem. O PCM (s16le, 48 kHz, estéreo) sai por `pcm`; o resto, por `events`.
    pub fn start(&mut self, policy: Policy, self_pid: u32, pcm: PcmSink, events: EventSink) -> Result<Format, String> {
        self.stop();
        let st = self.status();
        if !st.supported {
            return Err(st.reason.unwrap_or_else(|| "indisponível".into()));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let rings: RingMap = Arc::new(Mutex::new(HashMap::new()));
        let policy = Arc::new(Mutex::new(policy));
        let (wake_tx, wake_rx) = mpsc::channel();

        let mixer_thread = {
            let (rings, stop) = (rings.clone(), stop.clone());
            std::thread::Builder::new().name("vb-mixer".into()).spawn(move || mixer::run_clock(rings, stop, |b| pcm(b))).map_err(|e| e.to_string())?
        };
        let manager_thread = {
            let (policy, rings, stop) = (policy.clone(), rings.clone(), stop.clone());
            std::thread::Builder::new().name("vb-appaudio".into()).spawn(move || manage_loop(self_pid, policy, rings, stop, wake_rx, events)).map_err(|e| e.to_string())?
        };
        self.running = Some(Running { stop, policy, wake: wake_tx, threads: vec![mixer_thread, manager_thread] });
        Ok(Format { rate: mixer::RATE, channels: 2, bits: 16 })
    }

    /// Muda as escolhas ao vivo, sem reiniciar (a varredura acorda na hora).
    pub fn update(&self, p: Policy) -> bool {
        let Some(r) = &self.running else { return false };
        if let Ok(mut g) = r.policy.lock() { *g = p; }
        let _ = r.wake.send(());
        true
    }

    pub fn stop(&mut self) {
        if let Some(r) = self.running.take() {
            r.stop.store(true, Ordering::SeqCst);
            let _ = r.wake.send(());
            for t in r.threads { let _ = t.join(); }
        }
    }

    pub fn capture_test(&self, pid: u32, secs: u32) -> TestResult { capture::capture_test(pid, secs) }
    pub fn probe(&self, pid: u32) -> Vec<ProbeRow> { capture::probe(pid, false) }
}

impl Drop for Service {
    fn drop(&mut self) { self.stop(); }
}

fn manage_loop(self_pid: u32, policy: Arc<Mutex<Policy>>, rings: RingMap, stop: Arc<AtomicBool>, wake: mpsc::Receiver<()>, on_event: EventSink) {
    let _com = ComGuard::init();
    let mut caps: HashMap<String, Capture> = HashMap::new();
    let mut retry: HashMap<String, Instant> = HashMap::new();
    let mut last_scan_err: Option<String> = None;
    let mut exclude_failed = false; // o modo "tudo menos eu" falhou: cai no modo por aplicativo

    while !stop.load(Ordering::SeqCst) {
        let pol = policy.lock().map(|g| g.clone()).unwrap_or_default();
        match apps::scan(self_pid) {
            Ok(sc) => {
                last_scan_err = None;
                let mut list = sc.apps;
                for a in &mut list {
                    a.included = pol.included(&a.key);
                }
                let use_exclude = pol.exclude_self_mode() && !exclude_failed;
                let desired: Vec<(String, u32, bool)> = if use_exclude {
                    vec![(ALL_KEY.into(), self_pid, true)]
                } else {
                    list.iter().filter(|a| a.included).map(|a| (a.key.clone(), a.pid, false)).collect()
                };

                // 1) para o que não é mais desejado ou falhou
                for k in caps.keys().cloned().collect::<Vec<_>>() {
                    let c = &caps[&k];
                    let wanted = desired.iter().any(|(dk, dp, dx)| *dk == k && *dp == c.pid && *dx == c.exclude);
                    let err = c.error();
                    if wanted && err.is_none() && !c.finished() { continue; }
                    if let Some(message) = err {
                        if k == ALL_KEY { exclude_failed = true; }
                        on_event(Event::CaptureError { app: k.clone(), message });
                        retry.insert(k.clone(), Instant::now() + RETRY_AFTER_ERROR);
                    }
                    if let Some(mut c) = caps.remove(&k) { c.stop(); }
                    if let Ok(mut m) = rings.lock() { m.remove(&k); }
                }
                // 2) liga o que falta
                for (k, pid, ex) in &desired {
                    if caps.contains_key(k) { continue; }
                    if retry.get(k).map_or(false, |t| Instant::now() < *t) { continue; }
                    let c = Capture::start(*pid, *ex);
                    if let Ok(mut m) = rings.lock() { m.insert(k.clone(), c.ring.clone()); }
                    caps.insert(k.clone(), c);
                }
                // 3) estado por aplicativo para a interface
                for a in &mut list {
                    let c = if use_exclude { caps.get(ALL_KEY) } else { caps.get(&a.key) };
                    if let Some(c) = c {
                        a.capturing = a.included && c.running();
                        a.error = c.error();
                    }
                }
                on_event(Event::Apps(list));
            }
            Err(e) => {
                if last_scan_err.as_deref() != Some(e.as_str()) {
                    last_scan_err = Some(e.clone());
                    on_event(Event::ScanError(e));
                }
            }
        }
        // dorme até a próxima varredura, ou acorda na hora se a política mudou / o serviço foi parado
        match wake.recv_timeout(SCAN_EVERY) {
            Ok(()) => { exclude_failed &= pol.exclude_self_mode(); } // mudou a escolha: tenta o modo único de novo se voltou a servir
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    for (_, mut c) in caps.drain() { c.stop(); }
    if let Ok(mut m) = rings.lock() { m.clear(); }
}
