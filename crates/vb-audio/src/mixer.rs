//! Mixagem de PCM (portátil e testável): anéis por aplicativo, conversão/reamostragem para
//! 48 kHz s16 estéreo, limitador e relógio único de saída.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
/// Folga máxima por aplicativo: ~83 ms (em amostras estéreo intercaladas).
pub const MAX_BACKLOG: usize = (RATE as usize) * CHANNELS / 12;
const MIN_BLOCK_FRAMES: i64 = 240; // 5 ms
const MAX_BLOCK_FRAMES: i64 = 4800; // 100 ms

// ---------------------------------------------------------------------------------------------
/// Anel de amostras s16 intercaladas. Quando enche, descarta as mais antigas (latência nunca cresce).
/// Usa `Mutex` com seções críticas curtas (cópia de poucos KB); sem alocação no caminho quente.
pub struct Ring {
    inner: Mutex<RingInner>,
}
struct RingInner {
    buf: Vec<i16>,
    rd: usize,
    len: usize,
}

impl Ring {
    pub fn new(capacity_samples: usize) -> Self {
        Self { inner: Mutex::new(RingInner { buf: vec![0; capacity_samples.max(2)], rd: 0, len: 0 }) }
    }
    pub fn write(&self, s: &[i16]) {
        let Ok(mut g) = self.inner.lock() else { return };
        let cap = g.buf.len();
        let s = if s.len() > cap { &s[s.len() - cap..] } else { s };
        let overflow = (g.len + s.len()).saturating_sub(cap);
        if overflow > 0 {
            g.rd = (g.rd + overflow) % cap;
            g.len -= overflow;
        }
        let mut w = (g.rd + g.len) % cap;
        for v in s {
            g.buf[w] = *v;
            w = (w + 1) % cap;
        }
        g.len += s.len();
    }
    pub fn len(&self) -> usize { self.inner.lock().map(|g| g.len).unwrap_or(0) }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    /// Soma até `acc.len()` amostras em `acc`; antes disso descarta o atraso acima de `max_backlog`.
    pub fn mix_into(&self, acc: &mut [i32], max_backlog: usize) {
        let Ok(mut g) = self.inner.lock() else { return };
        let cap = g.buf.len();
        if g.len > acc.len() + max_backlog {
            let drop = g.len - acc.len() - max_backlog;
            g.rd = (g.rd + drop) % cap;
            g.len -= drop;
        }
        let take = g.len.min(acc.len());
        for a in acc.iter_mut().take(take) {
            *a += g.buf[g.rd] as i32;
            g.rd = (g.rd + 1) % cap;
        }
        g.len -= take;
    }
}

// ---------------------------------------------------------------------------------------------
/// Converte o formato capturado (PCM16 ou float32, estéreo, qualquer taxa) para s16 48 kHz estéreo.
/// Reamostragem linear com estado entre blocos.
pub struct Converter {
    src_rate: u32,
    float: bool,
    pos: f64,
    prev: [f32; 2],
}

impl Converter {
    pub fn new(src_rate: u32, float: bool) -> Self { Self { src_rate, float, pos: 0.0, prev: [0.0; 2] } }

    pub fn push(&mut self, data: &[u8], frames: usize, silent: bool, out: &mut Vec<i16>) {
        let n = frames * 2;
        let mut inb = vec![0f32; n];
        if !silent {
            if self.float {
                for (d, c) in inb.iter_mut().zip(data.chunks_exact(4)) { *d = f32::from_le_bytes([c[0], c[1], c[2], c[3]]); }
            } else {
                for (d, c) in inb.iter_mut().zip(data.chunks_exact(2)) { *d = i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0; }
            }
        }
        if self.src_rate == RATE {
            out.extend(inb.iter().map(|v| to_i16(*v)));
            return;
        }
        let step = self.src_rate as f64 / RATE as f64;
        let mut comb = Vec::with_capacity(n + 2);
        comb.extend_from_slice(&self.prev);
        comb.extend_from_slice(&inb);
        while self.pos < frames as f64 {
            let i = self.pos as usize;
            let fr = (self.pos - i as f64) as f32;
            for ch in 0..2 {
                let a = comb[2 * i + ch];
                let b = comb[2 * (i + 1) + ch];
                out.push(to_i16(a * (1.0 - fr) + b * fr));
            }
            self.pos += step;
        }
        self.pos -= frames as f64;
        self.prev = [comb[2 * frames], comb[2 * frames + 1]];
    }
}

fn to_i16(v: f32) -> i16 { (v * 32767.0).round().clamp(-32768.0, 32767.0) as i16 }

// ---------------------------------------------------------------------------------------------
/// Limitador por bloco: se a soma de vários aplicativos passar do teto, baixa o ganho do bloco inteiro
/// (em vez de cortar as ondas, que gera distorção) e volta ao normal devagar.
pub struct Limiter {
    gain: f32,
}
impl Default for Limiter {
    fn default() -> Self { Self { gain: 1.0 } }
}
impl Limiter {
    pub fn process(&mut self, acc: &[i32], out: &mut [i16]) {
        let peak = acc.iter().map(|v| v.unsigned_abs()).max().unwrap_or(0) as f32;
        let target = if peak > 32767.0 { 32767.0 / peak } else { 1.0 };
        self.gain = if target < self.gain { target } else { (self.gain + 0.01).min(1.0) };
        for (o, a) in out.iter_mut().zip(acc) {
            *o = (*a as f32 * self.gain).round().clamp(-32768.0, 32767.0) as i16;
        }
    }
}

// ---------------------------------------------------------------------------------------------
pub type RingMap = Arc<Mutex<HashMap<String, Arc<Ring>>>>;

/// Relógio único: emite exatamente `RATE` quadros por segundo de relógio de parede (sem deriva),
/// com silêncio quando ninguém está tocando (a faixa WebRTC não "morre").
pub fn run_clock(rings: RingMap, stop: Arc<AtomicBool>, mut on_pcm: impl FnMut(&[i16])) {
    let t0 = Instant::now();
    let mut emitted: i64 = 0;
    let mut acc = vec![0i32; MAX_BLOCK_FRAMES as usize * CHANNELS];
    let mut out = vec![0i16; acc.len()];
    let mut limiter = Limiter::default();
    while !stop.load(Ordering::Relaxed) {
        let due = (t0.elapsed().as_micros() as i64) * RATE as i64 / 1_000_000;
        let mut todo = due - emitted;
        if todo < MIN_BLOCK_FRAMES {
            std::thread::sleep(Duration::from_millis(4));
            continue;
        }
        if todo > MAX_BLOCK_FRAMES * 4 {
            // o sistema parou por um bom tempo (suspensão/travada): pula em vez de despejar uma rajada
            emitted = due - MAX_BLOCK_FRAMES;
            todo = MAX_BLOCK_FRAMES;
        }
        let frames = todo.min(MAX_BLOCK_FRAMES) as usize;
        let samples = frames * CHANNELS;
        acc[..samples].fill(0);
        let list: Vec<Arc<Ring>> = rings.lock().map(|m| m.values().cloned().collect()).unwrap_or_default();
        for r in &list {
            r.mix_into(&mut acc[..samples], MAX_BACKLOG);
        }
        limiter.process(&acc[..samples], &mut out[..samples]);
        on_pcm(&out[..samples]);
        emitted += frames as i64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm16(v: &[i16]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

    #[test]
    fn ring_keeps_order_and_overwrites_oldest() {
        let r = Ring::new(4);
        r.write(&[1, 2, 3]);
        r.write(&[4, 5, 6]); // estoura: perde 1 e 2
        let mut acc = [0i32; 4];
        r.mix_into(&mut acc, 100);
        assert_eq!(acc, [3, 4, 5, 6]);
        assert!(r.is_empty());
    }

    #[test]
    fn ring_write_larger_than_capacity_keeps_the_tail() {
        let r = Ring::new(3);
        r.write(&[1, 2, 3, 4, 5]);
        let mut acc = [0i32; 3];
        r.mix_into(&mut acc, 100);
        assert_eq!(acc, [3, 4, 5]);
    }

    #[test]
    fn mix_drops_backlog_beyond_limit_keeping_the_newest() {
        let r = Ring::new(100);
        r.write(&(0..50).collect::<Vec<i16>>());
        let mut acc = [0i32; 10];
        r.mix_into(&mut acc, 5); // pode sobrar 5 além dos 10 pedidos: descarta 35
        assert_eq!(acc[0], 35);
        assert_eq!(r.len(), 5);
    }

    #[test]
    fn mix_sums_multiple_rings() {
        let (a, b) = (Ring::new(8), Ring::new(8));
        a.write(&[100, 100]);
        b.write(&[-30, 5]);
        let mut acc = [0i32; 2];
        a.mix_into(&mut acc, 10);
        b.mix_into(&mut acc, 10);
        assert_eq!(acc, [70, 105]);
    }

    #[test]
    fn converter_passthrough_at_48k_pcm16() {
        let mut c = Converter::new(48_000, false);
        let mut out = vec![];
        c.push(&pcm16(&[1000, -1000, 2000, -2000]), 2, false, &mut out);
        assert_eq!(out, vec![1000, -1000, 2000, -2000]);
    }

    #[test]
    fn converter_float_and_silence() {
        let mut c = Converter::new(48_000, true);
        let bytes: Vec<u8> = [0.5f32, -0.5].iter().flat_map(|f| f.to_le_bytes()).collect();
        let mut out = vec![];
        c.push(&bytes, 1, false, &mut out);
        assert_eq!(out, vec![16384, -16384]);
        out.clear();
        c.push(&bytes, 1, true, &mut out);
        assert_eq!(out, vec![0, 0]);
    }

    #[test]
    fn resampler_44100_to_48000_produces_the_right_amount_over_time() {
        let mut c = Converter::new(44_100, false);
        let mut out = vec![];
        // 1 s de áudio em blocos de 441 quadros (10 ms)
        let block = pcm16(&vec![1000i16; 441 * 2]);
        for _ in 0..100 {
            c.push(&block, 441, false, &mut out);
        }
        let frames = out.len() / 2;
        assert!((frames as i64 - 48_000).abs() <= 2, "saiu {frames} quadros");
        // sinal constante continua constante (depois do primeiro quadro, que interpola com o silêncio inicial)
        assert!(out[4..].iter().all(|v| (*v - 1000).abs() <= 1));
    }

    #[test]
    fn limiter_never_clips_and_recovers() {
        let mut l = Limiter::default();
        let acc = vec![60_000i32, -60_000, 10_000, -10_000];
        let mut out = vec![0i16; 4];
        l.process(&acc, &mut out);
        assert!((out[0] as i32 - 32767).abs() <= 1, "o pico vira o teto, não passa dele");
        let quiet = vec![1000i32; 4];
        for _ in 0..200 { l.process(&quiet, &mut out); }
        assert_eq!(out[0], 1000, "ganho volta a 1");
    }

    #[test]
    fn clock_emits_about_real_time_and_stops() {
        let stop = Arc::new(AtomicBool::new(false));
        let rings: RingMap = Arc::new(Mutex::new(HashMap::new()));
        let total = Arc::new(Mutex::new(0usize));
        let (s2, t2) = (stop.clone(), total.clone());
        let h = std::thread::spawn(move || run_clock(rings, s2, move |b| *t2.lock().unwrap() += b.len()));
        std::thread::sleep(Duration::from_millis(300));
        stop.store(true, Ordering::Relaxed);
        h.join().unwrap();
        let frames = *total.lock().unwrap() / 2;
        assert!((10_000..=16_500).contains(&frames), "300 ms ≈ 14400 quadros, veio {frames}");
    }
}
