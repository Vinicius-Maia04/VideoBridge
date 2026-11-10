//! Captura de áudio de UM processo (ou de "tudo menos um processo") com a API de loopback por processo
//! do Windows: `ActivateAudioInterfaceAsync("VAD\Process_Loopback")` (build 19041+).
use super::hr;
use crate::mixer::{Converter, Ring};
use crate::{ProbeRow, TestResult};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use std::ffi::c_void;
use std::sync::atomic::AtomicU32;
use windows::core::{w, IUnknown, Interface, GUID, HRESULT};
use windows::Win32::Foundation::{CloseHandle, E_NOINTERFACE, E_POINTER, S_OK};
use windows::Win32::Media::Audio::{
    IActivateAudioInterfaceAsyncOperation, IAudioCaptureClient, IAudioClient, AUDCLNT_SHAREMODE_SHARED,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{AvSetMmThreadCharacteristicsW, CreateEventW, WaitForSingleObject};

const LOOPBACK: u32 = 0x0002_0000;
const EVENTCALLBACK: u32 = 0x0004_0000;
const NOPERSIST: u32 = 0x0008_0000;
const SRC_DEFAULT_QUALITY: u32 = 0x0800_0000;
const AUTOCONVERTPCM: u32 = 0x8000_0000;

/// Inicializa o COM (MTA) na thread atual e desfaz ao sair do escopo.
pub struct ComGuard(bool);
impl ComGuard {
    pub fn init() -> Self {
        // S_FALSE (já inicializado) também conta como sucesso; RPC_E_CHANGED_MODE a gente só segue sem desfazer
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() })
    }
}
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Ativação
// ---------------------------------------------------------------------------------------------
type Slot = Arc<(Mutex<Option<Result<IUnknown, HRESULT>>>, Condvar)>;

// Objeto COM do callback escrito à mão (IUnknown + IActivateAudioInterfaceCompletionHandler + IAgileObject):
// evita depender do macro `#[implement]`, que muda de API entre versões da crate `windows`.
const IID_UNKNOWN: GUID = GUID::from_u128(0x00000000_0000_0000_c000_000000000046);
const IID_AGILE: GUID = GUID::from_u128(0x94ea2b94_e9cc_49e0_c0ff_ee64ca8f5b90);
const IID_HANDLER: GUID = GUID::from_u128(0x41d949ab_9862_444a_80f6_c261334da5eb);

#[repr(C)]
struct HandlerVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    activate_completed: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
}
#[repr(C)]
struct HandlerObj {
    vtbl: *const HandlerVtbl,
    refs: AtomicU32,
    slot: Slot,
}

unsafe extern "system" fn h_qi(this: *mut c_void, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    let iid = *iid;
    if iid == IID_UNKNOWN || iid == IID_AGILE || iid == IID_HANDLER {
        *out = this;
        h_add_ref(this);
        S_OK
    } else {
        *out = std::ptr::null_mut();
        E_NOINTERFACE
    }
}
unsafe extern "system" fn h_add_ref(this: *mut c_void) -> u32 {
    (*(this as *const HandlerObj)).refs.fetch_add(1, Ordering::SeqCst) + 1
}
unsafe extern "system" fn h_release(this: *mut c_void) -> u32 {
    let n = (*(this as *const HandlerObj)).refs.fetch_sub(1, Ordering::SeqCst) - 1;
    if n == 0 {
        drop(Box::from_raw(this as *mut HandlerObj));
    }
    n
}
unsafe extern "system" fn h_completed(this: *mut c_void, op: *mut c_void) -> HRESULT {
    let obj = &*(this as *const HandlerObj);
    let res = (|| -> Result<IUnknown, HRESULT> {
        if op.is_null() {
            return Err(E_POINTER);
        }
        // `op` é emprestado do chamador: não pode ser liberado aqui
        let op = std::mem::ManuallyDrop::new(IActivateAudioInterfaceAsyncOperation::from_raw(op));
        let mut result = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        op.GetActivateResult(&mut result, &mut unk).map_err(|e| e.code())?;
        if result.is_err() {
            return Err(result);
        }
        unk.ok_or(E_POINTER)
    })();
    let (m, cv) = &*obj.slot;
    if let Ok(mut g) = m.lock() {
        *g = Some(res);
    }
    cv.notify_all();
    S_OK
}
static HANDLER_VTBL: HandlerVtbl = HandlerVtbl { query_interface: h_qi, add_ref: h_add_ref, release: h_release, activate_completed: h_completed };

#[link(name = "mmdevapi")]
extern "system" {
    fn ActivateAudioInterfaceAsync(path: *const u16, riid: *const GUID, params: *const c_void, handler: *mut c_void, op: *mut *mut c_void) -> HRESULT;
}

/// PROPVARIANT do tipo VT_BLOB (65): vt + 3 reservados + { cbSize, pBlobData }. O `repr(C)` insere o
/// preenchimento certo em x86 e x64 (24 e 16 bytes).
#[repr(C)]
struct PropVariantBlob {
    vt: u16,
    reserved: [u16; 3],
    cb_size: u32,
    p_blob_data: *mut u8,
}

/// `exclude = false`: só a árvore de `pid`. `exclude = true`: TUDO, menos a árvore de `pid`.
fn activate(pid: u32, exclude: bool) -> Result<IAudioClient, String> {
    unsafe {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: if exclude { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE },
                },
            },
        };
        let pv = PropVariantBlob { vt: 65, reserved: [0; 3], cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, p_blob_data: &params as *const _ as *mut u8 };

        let slot: Slot = Arc::new((Mutex::new(None), Condvar::new()));
        let obj = Box::into_raw(Box::new(HandlerObj { vtbl: &HANDLER_VTBL, refs: AtomicU32::new(1), slot: slot.clone() })) as *mut c_void;
        let mut op: *mut c_void = std::ptr::null_mut();
        let hr_call = ActivateAudioInterfaceAsync(w!("VAD\\Process_Loopback").0, &IAudioClient::IID, &pv as *const _ as *const c_void, obj, &mut op);
        h_release(obj); // nossa referência; o Windows guarda a dele enquanto precisar
        if !op.is_null() {
            drop(IActivateAudioInterfaceAsyncOperation::from_raw(op));
        }
        if hr_call.is_err() {
            return Err(format!("ActivateAudioInterfaceAsync falhou (HRESULT {})", hr::text(hr_call.0)));
        }

        let (m, cv) = &*slot;
        let guard = m.lock().map_err(|_| "estado de ativação corrompido".to_string())?;
        let (mut guard, to) = cv.wait_timeout_while(guard, Duration::from_secs(8), |s| s.is_none()).map_err(|_| "estado de ativação corrompido".to_string())?;
        if to.timed_out() {
            return Err("ActivateAudioInterfaceAsync: tempo esgotado".into());
        }
        match guard.take() {
            Some(Ok(unk)) => unk.cast::<IAudioClient>().map_err(|_| "a ativação não devolveu IAudioClient".to_string()),
            Some(Err(h)) => Err(format!("GetActivateResult falhou (HRESULT {})", hr::text(h.0))),
            None => Err("ativação sem resultado".into()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Matriz de formatos/flags
// ---------------------------------------------------------------------------------------------
// O Initialize do loopback por processo é exigente (já visto: 0x88890021 AUDCLNT_E_INVALID_STREAM_FLAG no
// Windows 11 build 26200). A combinação DOCUMENTADA pela Microsoft (exemplo ApplicationLoopback) vem primeiro;
// as outras são rede de segurança. A que funcionar é lembrada para as próximas capturas.
#[derive(Clone, Copy, Debug)]
pub struct Attempt {
    pub name: &'static str,
    pub float: bool,
    pub rate: u32,
    pub flags: u32,
    pub dur: i64,
}
impl Attempt {
    fn event(&self) -> bool { self.flags & EVENTCALLBACK != 0 }
}

const EVT: u32 = LOOPBACK | EVENTCALLBACK;
const ATTEMPTS: &[Attempt] = &[
    Attempt { name: "PCM16/44100 evt+nopersist dur=200000", float: false, rate: 44100, flags: EVT | NOPERSIST, dur: 200_000 },
    Attempt { name: "PCM16/48000 evt+nopersist dur=200000", float: false, rate: 48000, flags: EVT | NOPERSIST, dur: 200_000 },
    Attempt { name: "PCM16/48000 evt dur=200000", float: false, rate: 48000, flags: EVT, dur: 200_000 },
    Attempt { name: "PCM16/44100 evt dur=200000", float: false, rate: 44100, flags: EVT, dur: 200_000 },
    Attempt { name: "F32/48000 evt+nopersist dur=200000", float: true, rate: 48000, flags: EVT | NOPERSIST, dur: 200_000 },
    Attempt { name: "F32/44100 evt+nopersist dur=200000", float: true, rate: 44100, flags: EVT | NOPERSIST, dur: 200_000 },
    Attempt { name: "PCM16/48000 evt dur=0", float: false, rate: 48000, flags: EVT, dur: 0 },
    Attempt { name: "PCM16/48000 evt+autoconv dur=0", float: false, rate: 48000, flags: EVT | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, dur: 0 },
    Attempt { name: "PCM16/48000 poll+autoconv dur=200000", float: false, rate: 48000, flags: LOOPBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, dur: 200_000 },
];
static CHOSEN: AtomicUsize = AtomicUsize::new(0); // índice + 1; 0 = nenhuma ainda

fn order() -> Vec<usize> {
    let mut o: Vec<usize> = (0..ATTEMPTS.len()).collect();
    let c = CHOSEN.load(Ordering::Relaxed);
    if c > 0 {
        o.retain(|i| *i != c - 1);
        o.insert(0, c - 1);
    }
    o
}

fn wave_format(a: &Attempt) -> WAVEFORMATEX {
    let bits: u16 = if a.float { 32 } else { 16 };
    let block = 2 * bits / 8;
    WAVEFORMATEX { wFormatTag: if a.float { 3 } else { 1 }, nChannels: 2, nSamplesPerSec: a.rate, nAvgBytesPerSec: a.rate * block as u32, nBlockAlign: block, wBitsPerSample: bits, cbSize: 0 }
}

/// Tenta as combinações até uma funcionar (cada falha de Initialize exige reativar o cliente).
fn init_client(pid: u32, exclude: bool, trace: &mut Vec<(String, String)>) -> Result<(IAudioClient, Attempt), String> {
    for i in order() {
        let a = ATTEMPTS[i];
        let client = activate(pid, exclude)?; // falha de ativação não depende do formato: não adianta insistir
        let fmt = wave_format(&a);
        match unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, a.flags, a.dur, 0, &fmt, None) } {
            Ok(()) => {
                CHOSEN.store(i + 1, Ordering::Relaxed);
                return Ok((client, a));
            }
            Err(e) => trace.push((a.name.to_string(), hr::text(e.code().0))),
        }
    }
    Err(summarize(trace))
}

fn summarize(trace: &[(String, String)]) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for (_, h) in trace {
        match counts.iter_mut().find(|(k, _)| k == h) {
            Some((_, n)) => *n += 1,
            None => counts.push((h.clone(), 1)),
        }
    }
    let list = counts.iter().map(|(k, n)| format!("{k} x{n}")).collect::<Vec<_>>().join("; ");
    format!("IAudioClient.Initialize falhou em todas as {} combinações de formato/flags: {list}. Primeira tentativa: {}", trace.len(), trace.first().map(|t| t.0.as_str()).unwrap_or("-"))
}

/// Testa TODAS as combinações e devolve o HRESULT de cada uma (diagnóstico).
pub fn probe(pid: u32, exclude: bool) -> Vec<ProbeRow> {
    let _com = ComGuard::init();
    ATTEMPTS
        .iter()
        .map(|a| match activate(pid, exclude) {
            Err(e) => ProbeRow { name: a.name.into(), hr: e, ok: false },
            Ok(c) => {
                let fmt = wave_format(a);
                match unsafe { c.Initialize(AUDCLNT_SHAREMODE_SHARED, a.flags, a.dur, 0, &fmt, None) } {
                    Ok(()) => ProbeRow { name: a.name.into(), hr: "0x00000000".into(), ok: true },
                    Err(e) => ProbeRow { name: a.name.into(), hr: hr::text(e.code().0), ok: false },
                }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Laço de captura
// ---------------------------------------------------------------------------------------------
fn capture_loop(client: &IAudioClient, used: Attempt, stop: &AtomicBool, mut sink: impl FnMut(&[i16], u64)) -> Result<(), String> {
    unsafe {
        let ev = CreateEventW(None, false, false, None).map_err(|e| format!("CreateEvent: {}", hr::text(e.code().0)))?;
        let result = (|| -> Result<(), String> {
            if used.event() {
                client.SetEventHandle(ev).map_err(|e| format!("IAudioClient.SetEventHandle: {}", hr::text(e.code().0)))?;
            }
            let cap: IAudioCaptureClient = client.GetService().map_err(|e| format!("GetService(IAudioCaptureClient): {}", hr::text(e.code().0)))?;
            client.Start().map_err(|e| format!("IAudioClient.Start: {}", hr::text(e.code().0)))?;
            let block = if used.float { 8usize } else { 4usize };
            let mut conv = Converter::new(used.rate, used.float);
            let mut out: Vec<i16> = Vec::with_capacity(4096);
            while !stop.load(Ordering::Relaxed) {
                if used.event() {
                    WaitForSingleObject(ev, 100);
                } else {
                    std::thread::sleep(Duration::from_millis(5));
                }
                loop {
                    let n = cap.GetNextPacketSize().map_err(|e| format!("GetNextPacketSize: {}", hr::text(e.code().0)))?;
                    if n == 0 {
                        break;
                    }
                    let (mut data, mut frames, mut flags) = (std::ptr::null_mut::<u8>(), 0u32, 0u32);
                    if cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() {
                        break;
                    }
                    let silent = flags & 2 != 0 || data.is_null(); // AUDCLNT_BUFFERFLAGS_SILENT
                    let bytes: &[u8] = if silent { &[] } else { std::slice::from_raw_parts(data, frames as usize * block) };
                    out.clear();
                    conv.push(bytes, frames as usize, silent, &mut out);
                    sink(&out, frames as u64);
                    cap.ReleaseBuffer(frames).map_err(|e| format!("ReleaseBuffer: {}", hr::text(e.code().0)))?;
                }
            }
            let _ = client.Stop();
            Ok(())
        })();
        let _ = CloseHandle(ev);
        result
    }
}

pub struct CaptureState {
    running: AtomicBool,
    finished: AtomicBool,
    error: Mutex<Option<String>>,
}

pub struct Capture {
    pub pid: u32,
    pub exclude: bool,
    pub ring: Arc<Ring>,
    state: Arc<CaptureState>,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Capture {
    pub fn start(pid: u32, exclude: bool) -> Self {
        let ring = Arc::new(Ring::new(crate::mixer::RATE as usize * 2)); // 1 s de folga física
        let state = Arc::new(CaptureState { running: AtomicBool::new(false), finished: AtomicBool::new(false), error: Mutex::new(None) });
        let stop = Arc::new(AtomicBool::new(false));
        let (r, s, st) = (ring.clone(), state.clone(), stop.clone());
        let join = std::thread::Builder::new()
            .name(format!("vb-capture-{pid}"))
            .spawn(move || {
                let _com = ComGuard::init();
                // MMCSS: prioridade de áudio em tempo real para não perder pacotes sob carga (jogo + encoder)
                let mut task = 0u32;
                let mm = unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task) }.ok();
                let res = (|| -> Result<(), String> {
                    let mut trace = Vec::new();
                    let (client, used) = init_client(pid, exclude, &mut trace)?;
                    s.running.store(true, Ordering::SeqCst);
                    capture_loop(&client, used, &st, |pcm, _| r.write(pcm))
                })();
                if let Err(e) = res {
                    if let Ok(mut g) = s.error.lock() { *g = Some(e); }
                }
                s.running.store(false, Ordering::SeqCst);
                s.finished.store(true, Ordering::SeqCst);
                let _ = mm;
            })
            .ok();
        Self { pid, exclude, ring, state, stop, join }
    }
    pub fn running(&self) -> bool { self.state.running.load(Ordering::SeqCst) }
    pub fn finished(&self) -> bool { self.state.finished.load(Ordering::SeqCst) }
    pub fn error(&self) -> Option<String> { self.state.error.lock().ok().and_then(|g| g.clone()) }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() { let _ = j.join(); }
    }
}
impl Drop for Capture {
    fn drop(&mut self) { self.stop(); }
}

/// Testa a captura de UM processo por `secs` segundos (início da API, formato, permissões).
pub fn capture_test(pid: u32, secs: u32) -> TestResult {
    let _com = ComGuard::init();
    let mut trace = Vec::new();
    let (client, used) = match init_client(pid, false, &mut trace) {
        Ok(x) => x,
        Err(e) => return TestResult { ok: false, error: Some(e), ..Default::default() },
    };
    let stop = Arc::new(AtomicBool::new(false));
    let frames = Arc::new(AtomicU64::new(0));
    let (s2, secs) = (stop.clone(), secs.clamp(1, 10));
    let timer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(secs as u64));
        s2.store(true, Ordering::SeqCst);
    });
    let f2 = frames.clone();
    let r = capture_loop(&client, used, &stop, move |_, n| { f2.fetch_add(n, Ordering::Relaxed); });
    let _ = timer.join();
    match r {
        Ok(()) => TestResult { ok: true, format: Some(used.name.into()), frames: frames.load(Ordering::Relaxed), error: None },
        Err(e) => TestResult { ok: false, format: Some(used.name.into()), frames: frames.load(Ordering::Relaxed), error: Some(e) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn documented_combination_is_tried_first() {
        assert_eq!(ATTEMPTS[0].rate, 44100);
        assert!(!ATTEMPTS[0].float);
        assert_eq!(ATTEMPTS[0].flags, LOOPBACK | EVENTCALLBACK | NOPERSIST);
    }
    #[test]
    fn every_attempt_asks_for_loopback_and_valid_format() {
        for a in ATTEMPTS {
            assert!(a.flags & LOOPBACK != 0, "{}", a.name);
            assert!(a.rate == 44100 || a.rate == 48000);
            let f = wave_format(a);
            let (block, bits, tag) = (f.nBlockAlign, f.wBitsPerSample, f.wFormatTag);
            assert_eq!(block, bits / 8 * 2);
            assert_eq!(tag, if a.float { 3 } else { 1 });
        }
    }
    #[test]
    fn summary_groups_equal_errors() {
        let t = vec![("a".to_string(), "0x1".to_string()), ("b".to_string(), "0x1".to_string()), ("c".to_string(), "0x2".to_string())];
        let s = summarize(&t);
        assert!(s.contains("0x1 x2") && s.contains("0x2 x1") && s.contains("3 combinações"));
    }
}
