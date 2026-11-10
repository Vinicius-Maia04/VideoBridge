'use strict';
/** Efeitos sonoros sintetizados (WebAudio): sem arquivos, sem direitos autorais. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VB = Object.assign(root.VB || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  // Cada som é uma sequência de notas {f: Hz, d: segundos}. A 1ª nota é única por som.
  const SOUNDS = {
    enter:      { wave: 'sine',   notes: [{ f: 523.25, d: 0.08 }, { f: 659.25, d: 0.08 }, { f: 783.99, d: 0.16 }] }, // eu entrei na sala
    leave:      { wave: 'sine',   notes: [{ f: 659.26, d: 0.08 }, { f: 523.25, d: 0.08 }, { f: 392.0, d: 0.16 }] },   // eu saí
    peerJoin:   { wave: 'sine',   notes: [{ f: 587.33, d: 0.07 }, { f: 880.0, d: 0.13 }] },                          // alguém entrou
    peerLeave:  { wave: 'sine',   notes: [{ f: 880.01, d: 0.07 }, { f: 587.33, d: 0.13 }] },                         // alguém saiu
    micOn:      { wave: 'triangle', notes: [{ f: 700, d: 0.06 }, { f: 1000, d: 0.09 }] },
    micOff:     { wave: 'triangle', notes: [{ f: 1000.01, d: 0.06 }, { f: 600, d: 0.09 }] },
    deafOn:     { wave: 'triangle', notes: [{ f: 440, d: 0.06 }, { f: 330, d: 0.06 }, { f: 262, d: 0.09 }] },
    deafOff:    { wave: 'triangle', notes: [{ f: 330.01, d: 0.06 }, { f: 440, d: 0.06 }, { f: 554.37, d: 0.09 }] },
    shareStart: { wave: 'sine',   notes: [{ f: 392.0, d: 0.07 }, { f: 523.25, d: 0.07 }, { f: 784.0, d: 0.14 }] },   // tela iniciada
    shareStop:  { wave: 'sine',   notes: [{ f: 466.16, d: 0.07 }, { f: 349.23, d: 0.07 }, { f: 261.63, d: 0.14 }] }, // tela encerrada
    camOn:      { wave: 'sine',   notes: [{ f: 740, d: 0.06 }, { f: 988, d: 0.1 }] },
    camOff:     { wave: 'sine',   notes: [{ f: 622.25, d: 0.06 }, { f: 466.16, d: 0.1 }] },
    error:      { wave: 'square', notes: [{ f: 196, d: 0.12 }, { f: 165, d: 0.16 }] },
  };
  const MIN_GAP_MS = 120; // evita rajada do mesmo som

  /**
   * getContext(): AudioContext já pronto (ou null). getVolume(): 0..1. isEnabled(): boolean.
   * Devolve { play(name) -> true se tocou }.
   */
  function createSfx({ getContext, getVolume = () => 0.5, isEnabled = () => true, now = () => Date.now() }) {
    const last = new Map();
    return {
      play(name) {
        const def = SOUNDS[name];
        if (!def || !isEnabled()) return false;
        const t = now();
        if (last.has(name) && t - last.get(name) < MIN_GAP_MS) return false;
        const ctx = getContext(); if (!ctx) return false;
        last.set(name, t);
        const vol = Math.min(1, Math.max(0, Number(getVolume()) || 0)) * 0.3;
        if (vol <= 0) return false;
        let at = ctx.currentTime + 0.01;
        for (const n of def.notes) {
          const osc = ctx.createOscillator(), g = ctx.createGain();
          osc.type = def.wave; osc.frequency.setValueAtTime(n.f, at);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.linearRampToValueAtTime(vol, at + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, at + n.d);
          osc.connect(g); g.connect(ctx.destination);
          osc.start(at); osc.stop(at + n.d + 0.03);
          at += n.d * 0.9;
        }
        return true;
      },
    };
  }
  return { SOUNDS, createSfx };
});
