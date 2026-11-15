const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/room-harness');

const ADM = 'adminAAAA1', PEER = 'peerBBBB22', OTHER = 'otherCCCC3';
const CODE = 'VB3.AAAAAAAAAAAAAAAAAAAAAA';
const hello = (t, r, name, extra = {}) => t.msg({ t: 'hello', r, name, ...extra });
/** Canal de dados de mentira (aberto) que o outro lado "criou": é por onde chegam e saem os comandos de admin. */
function attach(t, i) {
  const dc = { readyState: 'open', sent: [], l: {}, send(x) { this.sent.push(JSON.parse(x)); }, addEventListener(ty, f) { this.l[ty] = f; }, fire(o) { this.l.message({ data: JSON.stringify(o) }); } };
  t.pcs[i].fire('datachannel', { channel: dc });
  return dc;
}
const rows = (t) => t.$('#participants').children;
const roleOf = (row) => row.children.find((c) => /\brole\b/.test(c.className));
const menuOf = (row) => row.children.find((c) => c.className === 'rowmenu');
const clickItem = async (t, label) => { const mi = t.$('#adminMenu').children.find((c) => c.children && c.children.includes(label)); assert.ok(mi, `item "${label}" no menu: ${t.$('#adminMenu').children.map((c) => (c.children || []).filter((k) => typeof k === 'string'))}`); mi.click(); await t.tick(4); };

test('quem cria a sala é o dono (coroa) e já aparece como admin', async () => {
  const t = boot({ vbOverrides: { sigOpen: async () => ({ code: CODE, joinUrl: '' }) } }); await t.enter(); await t.tick(4);
  assert.match(roleOf(rows(t)[0]).className, /i-crown/);
});

test('quem entra aprende quem é o dono/admin pelo hello de quem já está na sala e não ganha controles', async () => {
  const t = boot(); await t.enter({ code: CODE }); hello(t, ADM, 'Ana', { admins: [ADM], owner: ADM }); await t.tick(6);
  const ana = rows(t).find((r) => /Ana/.test(r.children[1].textContent));
  assert.match(roleOf(ana).className, /i-crown/, 'Ana é a dona');
  assert.equal(menuOf(ana), undefined, 'eu não sou admin: sem menu de ações');
  assert.ok(t.$('#btnLock').classList.contains('hidden'));
});

test('um participante comum NÃO consegue se promover nem mandar comandos', async () => {
  const t = boot(); await t.enter({ code: CODE }); hello(t, ADM, 'Ana', { admins: [ADM], owner: ADM }); hello(t, PEER, 'Bia'); await t.tick(6);
  const dc = attach(t, 1);
  dc.fire({ t: 'adm', cmd: 'roles', admins: [PEER], owner: PEER }); // Bia tenta se declarar dona
  dc.fire({ t: 'adm', cmd: 'mute' }); dc.fire({ t: 'adm', cmd: 'kick', id: ADM }); await t.tick(6);
  assert.equal(t.$('#btnMic').disabled, false, 'comando de quem não é admin ignorado');
  assert.equal(t.$('#roomView').classList.contains('hidden'), false);
  assert.ok(!rows(t).some((r) => r.children[1] && /Bia/.test(r.children[1].textContent) && roleOf(r)), 'Bia continua sem selo');
});

test('admin silencia o microfone: fica bloqueado até ser liberado', async () => {
  const t = boot(); await t.enter({ code: CODE }); hello(t, ADM, 'Ana', { admins: [ADM], owner: ADM }); await t.tick(6);
  const dc = attach(t, 0);
  dc.fire({ t: 'adm', cmd: 'mute' }); await t.tick(4);
  assert.equal(t.$('#btnMic').disabled, true); assert.match(t.$('#msg').textContent, /Ana silenciou o seu microfone/);
  dc.fire({ t: 'adm', cmd: 'unmute' }); await t.tick(4);
  assert.equal(t.$('#btnMic').disabled, false);
});

test('admin expulsa: eu saio com o aviso; expulsar outra pessoa a remove da minha lista', async () => {
  const t = boot(); await t.enter({ code: CODE }); hello(t, ADM, 'Ana', { admins: [ADM], owner: ADM }); hello(t, PEER, 'Bia'); await t.tick(6);
  const dc = attach(t, 0);
  dc.fire({ t: 'adm', cmd: 'kick', id: PEER }); await t.tick(6);
  assert.ok(!rows(t).some((r) => r.children[1] && /Bia/.test(r.children[1].textContent)), 'Bia removida');
  dc.fire({ t: 'adm', cmd: 'kick', id: t.myId() }); await t.tick(8);
  assert.equal(t.$('#lobby').classList.contains('hidden'), false, 'voltei ao lobby');
  assert.match(t.$('#lobbyMsg').textContent, /removido da sala por Ana/);
});

test('admin não age sobre o dono, e outro admin só é mexido pelo dono', async () => {
  const t = boot({ vbOverrides: { sigOpen: async () => ({ code: CODE, joinUrl: '' }) } }); await t.enter(); hello(t, ADM, 'Ana'); await t.tick(6);
  const dc = attach(t, 0);
  // eu (dono) promovo a Ana; depois ela tenta me silenciar/expulsar: ignorado
  rows(t)[1].children.find((c) => c.className === 'rowmenu').click(); await t.tick(2); await clickItem(t, 'Tornar admin');
  dc.fire({ t: 'adm', cmd: 'mute' }); dc.fire({ t: 'adm', cmd: 'kick', id: t.myId() }); await t.tick(6);
  assert.equal(t.$('#btnMic').disabled, false, 'o dono não pode ser silenciado por outro admin');
  assert.equal(t.$('#roomView').classList.contains('hidden'), false, 'nem expulso');
});

test('menu do admin: silenciar, tornar admin e expulsar enviam os comandos pelo canal P2P', async () => {
  const t = boot({ vbOverrides: { sigOpen: async () => ({ code: CODE, joinUrl: '' }) } }); await t.enter(); hello(t, PEER, 'Bia'); hello(t, OTHER, 'Caio'); await t.tick(6);
  const dcB = attach(t, 0), dcC = attach(t, 1);
  const open = async (name) => { const row = rows(t).find((r) => r.children[1] && new RegExp(name).test(r.children[1].textContent)); menuOf(row).click(); await t.tick(2); };
  await open('Bia'); await clickItem(t, 'Silenciar microfone');
  assert.deepEqual(dcB.sent.at(-1), { t: 'adm', cmd: 'mute' });
  await open('Bia'); await clickItem(t, 'Liberar microfone');
  assert.deepEqual(dcB.sent.at(-1), { t: 'adm', cmd: 'unmute' });
  await open('Bia'); await clickItem(t, 'Tornar admin');
  assert.equal(dcB.sent.at(-1).cmd, 'roles'); assert.ok(dcB.sent.at(-1).admins.includes(PEER)); assert.ok(dcC.sent.at(-1).admins.includes(PEER), 'todos ficam sabendo');
  await open('Caio'); await clickItem(t, 'Expulsar da sala');
  assert.deepEqual(dcC.sent.find((m) => m.cmd === 'kick'), { t: 'adm', cmd: 'kick', id: OTHER });
  assert.ok(dcB.sent.some((m) => m.cmd === 'kick' && m.id === OTHER), 'os demais também são avisados');
  assert.ok(!rows(t).some((r) => r.children[1] && /Caio/.test(r.children[1].textContent)));
});

test('trancar a sala: ninguém novo entra (o admin responde "denied") e todos ficam sabendo', async () => {
  const t = boot({ vbOverrides: { sigOpen: async () => ({ code: CODE, joinUrl: '' }) } }); await t.enter(); hello(t, PEER, 'Bia'); await t.tick(6);
  const dc = attach(t, 0);
  t.$('#btnLock').click(); await t.tick(4);
  assert.deepEqual(dc.sent.at(-1), { t: 'adm', cmd: 'lock', on: true });
  hello(t, OTHER, 'Caio'); await t.tick(6);
  assert.equal(t.sent('denied').length, 1, 'quem tenta entrar é avisado');
  assert.ok(!rows(t).some((r) => r.children[1] && /Caio/.test(r.children[1].textContent)), 'e não entra na lista');
  t.$('#btnLock').click(); await t.tick(4);
  assert.deepEqual(dc.sent.at(-1), { t: 'adm', cmd: 'lock', on: false });
});

test('quem tenta entrar numa sala trancada recebe o aviso e sai', async () => {
  const t = boot(); await t.enter({ code: CODE }); await t.tick(4);
  t.msg({ t: 'denied', r: ADM, to: t.myId() }); await t.tick(8);
  assert.equal(t.$('#lobby').classList.contains('hidden'), false);
  assert.match(t.$('#lobbyMsg').textContent, /trancada/);
});

test('sucessão: se o único admin sai, o menor ID presente assume (e todos chegam ao mesmo resultado)', async () => {
  const t = boot(); await t.enter({ code: CODE }); hello(t, ADM, 'Ana', { admins: [ADM], owner: ADM }); await t.tick(6);
  assert.equal(menuOf(rows(t).find((r) => r.children[1] && /Ana/.test(r.children[1].textContent))), undefined);
  t.msg({ t: 'bye', r: ADM }); await t.tick(6);
  const me = rows(t)[0];
  assert.ok(roleOf(me), 'sobrei só eu: passo a ser admin');
  assert.ok(!t.$('#btnLock').classList.contains('hidden'));
});
