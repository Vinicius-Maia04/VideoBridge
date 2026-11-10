'use strict';
/**
 * AudioWorklet que toca PCM s16le estéreo (48 kHz) recebido por mensagens do thread principal.
 * Buffer circular com pré-enchimento (evita estalos no início) e limite de atraso (nunca acumula latência):
 * se a fila passar de ~200 ms, descarta o excesso mais antigo; se esvaziar, toca silêncio e volta a pré-encher.
 */
class VbPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000;                       // 1 s de folga física
    this.L = new Float32Array(this.cap); this.R = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.n = 0;
    this.primed = false;
    this.prime = 1920;                      // 40 ms antes de começar a tocar
    this.maxLatency = 9600;                 // 200 ms: acima disso descarta o mais antigo
    this.port.onmessage = (e) => { if (e.data && e.data.byteLength) this.push(new Int16Array(e.data)); };
  }
  push(pcm) {
    const frames = pcm.length >> 1;
    for (let i = 0; i < frames; i++) {
      if (this.n === this.cap) { this.r = (this.r + 1) % this.cap; this.n--; }
      this.L[this.w] = pcm[2 * i] / 32768; this.R[this.w] = pcm[2 * i + 1] / 32768;
      this.w = (this.w + 1) % this.cap; this.n++;
    }
    if (this.n > this.maxLatency) { const drop = this.n - this.maxLatency; this.r = (this.r + drop) % this.cap; this.n -= drop; }
  }
  process(_inputs, outputs) {
    const out = outputs[0], l = out[0], r = out[1] || out[0], len = l.length;
    if (!this.primed) { if (this.n >= this.prime) this.primed = true; }
    if (!this.primed) { l.fill(0); if (r !== l) r.fill(0); return true; }
    let i = 0;
    for (; i < len && this.n > 0; i++) {
      l[i] = this.L[this.r]; r[i] = this.R[this.r]; this.r = (this.r + 1) % this.cap; this.n--;
    }
    for (; i < len; i++) { l[i] = 0; r[i] = 0; }
    if (this.n === 0) this.primed = false; // esvaziou: pré-enche de novo (silêncio limpo em vez de estalos)
    return true;
  }
}
registerProcessor('vb-pcm', VbPcmProcessor);
