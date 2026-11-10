const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../ui/shared/zoom');
const { SOUNDS, createSfx } = require('../ui/shared/sfx');

test('zoom: o ponto sob o cursor fica fixo; nunca passa de 1x..8x e nunca mostra borda vazia', () => {
  const W = 800, H = 450, st0 = Z.ZOOM_RESET;
  const a = Z.zoomTo(st0, W, H, 400, 225, 2); assert.equal(a.s, 2);
  // ponto do conteúdo sob (400,225) antes e depois
  assert.equal((400 - st0.tx) / st0.s, (400 - a.tx) / a.s);
  assert.equal(Z.zoomTo(st0, W, H, 0, 0, 99).s, Z.ZOOM_MAX); assert.deepEqual({ ...Z.zoomTo(a, W, H, 0, 0, 0.1) }, { s: 1, tx: 0, ty: 0 });
  const c = Z.zoomTo(st0, W, H, 790, 440, 4); assert.ok(c.tx >= W * (1 - 4) && c.tx <= 0 && c.ty >= H * (1 - 4) && c.ty <= 0);
});
test('zoom: arrastar é limitado às bordas e sem zoom não arrasta', () => {
  assert.deepEqual({ ...Z.panBy(Z.ZOOM_RESET, 800, 450, 50, 50) }, { s: 1, tx: 0, ty: 0 });
  const z = Z.zoomTo(Z.ZOOM_RESET, 800, 450, 400, 225, 2);
  const p = Z.panBy(z, 800, 450, 9999, 9999); assert.equal(p.tx, 0); assert.equal(p.ty, 0);
  const q = Z.panBy(z, 800, 450, -9999, -9999); assert.equal(q.tx, -800); assert.equal(q.ty, -450);
});
test('zoom: aumentar e diminuir em passos volta EXATAMENTE a 100% (sem resíduo de ponto flutuante)', () => {
  let st = Z.ZOOM_RESET;
  for (let i = 0; i < 7; i++) st = Z.zoomBy(st, 800, 450, 400, 225, 1.25);
  for (let i = 0; i < 7; i++) st = Z.zoomBy(st, 800, 450, 400, 225, 1 / 1.25);
  assert.deepEqual({ ...st }, { s: 1, tx: 0, ty: 0 });
  let r = Z.ZOOM_RESET; for (let i = 0; i < 40; i++) r = Z.zoomBy(r, 800, 450, 123, 77, 1.2); for (let i = 0; i < 80; i++) r = Z.zoomBy(r, 800, 450, 123, 77, 1 / 1.2);
  assert.equal(r.s, 1);
});

test('sfx: toda sequência tem notas válidas e a 1ª nota de cada som é única', () => {
  const firsts = Object.values(SOUNDS).map((s) => s.notes[0].f);
  assert.equal(new Set(firsts).size, firsts.length);
  for (const [name, s] of Object.entries(SOUNDS)) { assert.ok(s.notes.length >= 2 && s.notes.length <= 4, name); for (const n of s.notes) { assert.ok(n.f >= 100 && n.f <= 2000 && n.d > 0 && n.d < 0.3, name); } }
  for (const n of ['enter', 'leave', 'peerJoin', 'peerLeave', 'micOn', 'micOff', 'deafOn', 'deafOff', 'shareStart', 'shareStop', 'camOn', 'camOff', 'error']) assert.ok(SOUNDS[n], n);
});
function fakeCtx() {
  const ctx = { currentTime: 1, destination: {}, osc: [], createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime(t, v) { this.peak = v; }, exponentialRampToValueAtTime() {} }, connect() {} }),
    createOscillator: () => { const o = { type: '', frequency: { setValueAtTime(f, t) { o.f = f; o.t = t; } }, connect() {}, start() {}, stop() {} }; ctx.osc.push(o); return o; } };
  return ctx;
}
test('sfx: agenda as notas em sequência, respeita volume/ligado e evita rajada', () => {
  const ctx = fakeCtx(); let t = 0, on = true, vol = 0.5;
  const sfx = createSfx({ getContext: () => ctx, getVolume: () => vol, isEnabled: () => on, now: () => t });
  assert.equal(sfx.play('enter'), true);
  assert.deepEqual(ctx.osc.map((o) => o.f), SOUNDS.enter.notes.map((n) => n.f)); assert.ok(ctx.osc[1].t > ctx.osc[0].t && ctx.osc[2].t > ctx.osc[1].t);
  assert.equal(sfx.play('enter'), false, 'mesmo som em <120 ms é ignorado'); t = 200; assert.equal(sfx.play('enter'), true);
  assert.equal(sfx.play('inexistente'), false);
  on = false; t = 999; assert.equal(sfx.play('leave'), false); on = true; vol = 0; assert.equal(sfx.play('leave'), false, 'volume 0 = mudo');
  const n = ctx.osc.length; vol = 1; assert.equal(createSfx({ getContext: () => null }).play('enter'), false); assert.equal(ctx.osc.length, n);
});
