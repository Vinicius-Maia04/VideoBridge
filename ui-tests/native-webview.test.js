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

// ---- cartões: clicar fora fecha; configurações pedem confirmação se houver alterações ----
async function press(t, id, type) { const el = t.$(id); el.fire(type, { target: el }); await t.tick(4); }

test('clicar no fundo escuro fecha o seletor de fontes', async () => {
  const t = boot(); await t.enter();
  t.$('#picker').classList.remove('hidden');
  await press(t, '#picker', 'pointerdown'); await press(t, '#picker', 'click');
  assert.ok(t.$('#picker').classList.contains('hidden'));
});
test('arrastar de dentro do cartão para o fundo NÃO fecha (clique que não começou no fundo)', async () => {
  const t = boot(); await t.enter();
  t.$('#picker').classList.remove('hidden');
  await press(t, '#picker', 'click'); // sem pointerdown no fundo
  assert.ok(!t.$('#picker').classList.contains('hidden'));
});
test('configurações: sem alterações, clicar fora fecha direto', async () => {
  const t = boot(); await t.enter();
  t.$('#btnSettings').click(); await t.tick(8);
  assert.ok(!t.$('#settings').classList.contains('hidden'));
  await press(t, '#settings', 'pointerdown'); await press(t, '#settings', 'click');
  assert.ok(t.$('#settings').classList.contains('hidden'));
  assert.ok(t.$('#confirmDlg').classList.contains('hidden'), 'não perguntou nada');
});
test('configurações: com alterações, clicar fora pergunta; "Continuar" mantém, "Descartar" fecha, "Salvar" grava e fecha', async () => {
  const t = boot(); await t.enter();
  const open = async () => { t.$('#btnSettings').click(); await t.tick(8); };
  const outside = async () => { await press(t, '#settings', 'pointerdown'); await press(t, '#settings', 'click'); };
  const saves = () => t.calls.filter((c) => c[0] === 'setConfig').length, before = saves();
  await open(); t.$('#myName').value = 'Outro Nome'; await outside();
  assert.ok(!t.$('#confirmDlg').classList.contains('hidden'), 'perguntou');
  t.$('#cfmKeep').click(); await t.tick(4);
  assert.ok(!t.$('#settings').classList.contains('hidden') && t.$('#confirmDlg').classList.contains('hidden'));
  await outside(); t.$('#cfmDiscard').click(); await t.tick(6);
  assert.ok(t.$('#settings').classList.contains('hidden'));
  assert.equal(saves(), before, 'descartar não grava');
  await open(); t.$('#myName').value = 'Outro Nome'; await outside(); t.$('#cfmSave').click(); await t.tick(10);
  assert.ok(t.calls.some((c) => c[0] === 'setConfig' && c[1].hostName === 'Outro Nome'), 'salvar grava');
  assert.ok(t.$('#settings').classList.contains('hidden'));
});

// ---- Rich Presence do Discord (convite pelo perfil) ----
const CODE = 'VB3.AAAAAAAAAAAAAAAAAAAAAA';
test('Rich Presence: a sala vai ao perfil, atualiza quando alguém entra e limpa ao sair', async () => {
  const t = boot({ vbOverrides: { sigOpen: async () => ({ code: CODE, joinUrl: '' }), richUpdate: async () => true, richClear: async () => {} } }); await t.enter(); await t.tick(8);
  const ups = () => t.calls.filter((c) => c[0] === 'richUpdate').map((c) => c[1]);
  assert.equal(ups()[0].code, CODE); assert.equal(ups()[0].people, 1);
  t.msg({ t: 'hello', r: 'aaaaaaaaaa', name: 'Ana' }); await t.tick(8);
  assert.equal(ups().pop().people, 2);
  const n = ups().length; t.msg({ t: 'hello', r: 'aaaaaaaaaa', name: 'Ana' }); await t.tick(6);
  assert.equal(ups().length, n, 'sem mudança não reenvia');
  t.$('#btnLeave').click(); await t.tick(12);
  assert.ok(t.calls.some((c) => c[0] === 'richClear'), 'sair limpa o perfil');
});
test('Rich Presence desligado nas configurações: nada é enviado ao Discord', async () => {
  const cfg = boot().config; cfg.discord = { announce: false, webhookUrl: '', joinPageUrl: '', presence: false };
  const t = boot({ cfg, vbOverrides: { sigOpen: async () => ({ code: CODE, joinUrl: '' }) } }); await t.enter(); await t.tick(8);
  t.msg({ t: 'hello', r: 'aaaaaaaaaa', name: 'Ana' }); await t.tick(8);
  assert.ok(!t.calls.some((c) => c[0] === 'richUpdate'));
});
test('a opção do Rich Presence faz parte da configuração salva (não se perde ao salvar)', async () => {
  const t = boot(); await t.enter();
  t.$('#btnSettings').click(); await t.tick(8);
  t.$('#dcPresence').checked = false; t.$('#btnSave').click(); await t.tick(10);
  assert.equal(t.calls.filter((c) => c[0] === 'setConfig').pop()[1].discord.presence, false);
});

// ---- sair e entrar nunca ficam presos na rede ----
const never = () => new Promise(() => {});
test('sair volta ao lobby NA HORA mesmo se o relay/Discord/RPC não respondem nunca', async () => {
  const t = boot({ vbOverrides: { sigClose: never, discordEnd: never, richClear: never, sigSend: never } }); await t.enter(); await t.tick(4);
  t.$('#btnLeave').click(); await t.tick(10);
  assert.equal(t.$('#lobby').classList.contains('hidden'), false, 'voltou ao lobby sem esperar a rede');
  t.$('#btnCreate').click(); await t.tick(6);
  assert.equal(t.calls.filter((c) => c[0] === 'sigOpen').length, 2, 'e dá para criar/entrar de novo');
});
test('o dono com o aviso do Discord ligado também sai sem travar se o webhook não responde', async () => {
  const cfg = boot().config; cfg.discord = { announce: true, webhookUrl: 'https://hook', joinPageUrl: '', presence: true };
  const t = boot({ cfg, vbOverrides: { discordAnnounce: async () => 'm', discordUpdate: async () => true, discordHandoffInfo: never, discordEnd: never } });
  await t.enter(); await t.tick(6); t.msg({ t: 'hello', r: 'aaaaaaaaaa', name: 'Ana' }); await t.tick(6);
  t.$('#btnLeave').click(); await new Promise((r) => setTimeout(r, 3300)); await t.tick(10);
  assert.equal(t.$('#lobby').classList.contains('hidden'), false, 'no máximo ~3 s esperando a passagem do aviso');
});
test('relay recusando mensagens (limite) avisa o usuário em vez de ficar mudo', async () => {
  const t = boot(); await t.enter(); await t.tick(4);
  t.handlers.onSigStatus({ state: 'limited', error: 'Relay respondeu HTTP 429' }); await t.tick(4);
  assert.match(t.$('#msg').textContent, /recusando mensagens/);
  assert.equal(t.$('#roomView').classList.contains('hidden'), false, 'não derruba a sala');
});
test('convite do Rich Presence para a sala em que já estou não reclama de "outra sala"', async () => {
  const t = boot({ vbOverrides: { sigOpen: async () => ({ code: 'VB3.AAAAAAAAAAAAAAAAAAAAAA', joinUrl: '' }) } }); await t.enter(); await t.tick(4);
  t.handlers.onInvite('VB3.AAAAAAAAAAAAAAAAAAAAAA'); await t.tick(3);
  assert.match(t.$('#msg').textContent, /já está nessa sala/);
  t.handlers.onInvite('VB3.BBBBBBBBBBBBBBBBBBBBBB'); await t.tick(3);
  assert.match(t.$('#msg').textContent, /Saia da sala atual/);
});
