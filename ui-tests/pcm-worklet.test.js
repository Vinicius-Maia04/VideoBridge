const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm'), fs = require('fs'), path = require('path');

function load() {
  let Cls; const ctx = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = {}; } }, registerProcessor: (n, c) => { assert.equal(n, 'vb-pcm'); Cls = c; }, Int16Array, Float32Array });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'pcm-worklet.js'), 'utf8'), ctx);
  const p = new Cls(); const send = (arr) => { const i16 = Int16Array.from(arr); p.port.onmessage({ data: i16.buffer }); };
  const run = (len = 128) => { const out = [new Float32Array(len), new Float32Array(len)]; p.process([], [out]); return out; };
  return { p, send, run };
}
const tone = (frames, v = 16384) => Array.from({ length: frames * 2 }, (_, i) => (i % 2 ? -v : v)); // L=+v, R=-v

test('worklet: silêncio até pré-encher (40 ms), depois toca estéreo com a escala correta', () => {
  const { send, run } = load();
  send(tone(500)); const a = run(); assert.ok(a[0].every((x) => x === 0), 'ainda pré-enchendo');
  send(tone(1500)); const b = run(); assert.equal(b[0][0], 0.5); assert.equal(b[1][0], -0.5); assert.ok(b[0].every((x) => x === 0.5));
});
test('worklet: esvaziou -> completa com silêncio e volta a pré-encher (sem estalos)', () => {
  const { send, run } = load(); send(tone(1920 + 100));
  const a = run(128); assert.equal(a[0][127], 0.5);
  let drained = 0; for (let i = 0; i < 40; i++) { const o = run(128); drained += o[0].filter((x) => x !== 0).length; }
  assert.equal(drained, 1920 + 100 - 128, 'tocou exatamente o que recebeu');
  send(tone(100)); assert.ok(run()[0].every((x) => x === 0), 'precisa pré-encher de novo');
});
test('worklet: nunca acumula latência (descarta o mais antigo acima de 200 ms)', () => {
  const { p, send } = load(); send(tone(48000 * 0.5 | 0)); assert.equal(p.n, 9600);
  send(tone(48000 * 2 | 0)); assert.ok(p.n <= 9600);
});
test('worklet: ordem preservada entre mensagens e mensagens vazias/ruins são ignoradas', () => {
  const { p, send, run } = load(); const ramp = (a, b) => { const o = []; for (let i = a; i < b; i++) o.push(i * 10, i * 10); return o; };
  send(ramp(0, 1000)); send(ramp(1000, 2000)); p.port.onmessage({ data: new ArrayBuffer(0) }); p.port.onmessage({}); p.port.onmessage({ data: null });
  const o = run(128); assert.equal(Math.round(o[0][0] * 32768), 0); assert.equal(Math.round(o[0][5] * 32768), 50); assert.equal(Math.round(o[0][127] * 32768), 1270);
});
