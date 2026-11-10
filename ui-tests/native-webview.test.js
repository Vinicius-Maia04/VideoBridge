const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot } = require('./helpers/room-harness');

test('WebView2: 🖥 abre direto o seletor do navegador (sem lista própria nem listSources/selectSource)', async () => {
  const t = boot({ vbOverrides: { nativePicker: true } }); await t.enter();
  t.$('#btnScreen').click(); await t.tick(6);
  assert.equal(t.gdm.length, 1, 'uma chamada a getDisplayMedia');
  assert.ok(!t.calls.some((c) => c[0] === 'listSources' || c[0] === 'selectSource'));
  assert.equal(t.calls.filter((c) => c[0] === 'setStreamState').pop()[1], 'STREAMING');
});

test('WebView2: sem o helper por aplicativo não tenta o loopback do Electron (e explica)', async () => {
  const t = boot({ vbOverrides: { nativePicker: true, appAudioStatus: async () => ({ supported: false, reason: 'Windows antigo' }) } }); await t.enter();
  t.$('#btnScreen').click(); await t.tick(6);
  const before = t.gdm.length;
  t.$('#btnSys').click(); await t.tick(8);
  assert.equal(t.gdm.length, before, 'nenhum getDisplayMedia extra para áudio');
  assert.match(t.$('#msg').textContent, /Windows antigo|Áudio do sistema indisponível/);
});

function loadCommon(extra = {}) {
  const w = { ...extra }; const ctx = vm.createContext({ window: w, setTimeout, clearTimeout, document: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'common.js'), 'utf8'), ctx);
  return w;
}
function fakePc() {
  const l = {};
  return { iceGatheringState: 'gathering', addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, removeEventListener(t, f) { l[t] = (l[t] || []).filter((x) => x !== f); }, fire(t, ev) { (l[t] || []).slice().forEach((f) => f(ev)); }, listeners: l };
}

test('iceComplete: com endereço público (srflx) não espera o timeout inteiro', async () => {
  const w = loadCommon(); const pc = fakePc(); const t0 = Date.now();
  const p = w.iceComplete(pc, 5000, 40);
  pc.fire('icecandidate', { candidate: { candidate: 'candidate:1 1 udp 2113937151 192.168.0.2 5000 typ host' } });
  setTimeout(() => pc.fire('icecandidate', { candidate: { candidate: 'candidate:2 1 udp 1677729535 200.1.2.3 5000 typ srflx raddr 0.0.0.0 rport 0' } }), 10);
  await p;
  assert.ok(Date.now() - t0 < 1000, 'terminou logo depois da tolerância');
  assert.equal((pc.listeners.icecandidate || []).length, 0, 'ouvintes removidos');
});

test('iceComplete: só candidatos locais esperam o timeout; "complete" termina na hora', async () => {
  const w = loadCommon(); const pc = fakePc(); const t0 = Date.now();
  const p = w.iceComplete(pc, 120, 20);
  pc.fire('icecandidate', { candidate: { candidate: 'candidate:1 1 udp 2113937151 192.168.0.2 5000 typ host' } });
  await p; assert.ok(Date.now() - t0 >= 100);
  const pc2 = fakePc(); pc2.iceGatheringState = 'complete';
  await w.iceComplete(pc2, 5000);
});
