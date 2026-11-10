/** Áudio por aplicativo no app: caminho nativo, queda para o modo "sistema inteiro" e painel do mixer. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/room-harness');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const APPS = [
  { key: 'chrome.exe', name: 'Google Chrome', pid: 100, active: true, peak: 0.5 },
  { key: 'spotify.exe', name: 'Spotify', pid: 200, active: true, peak: 0.1 },
  { key: 'discord.exe', name: 'Discord', pid: 300, active: false, peak: 0 },
];
function nativeApi(over = {}) {
  const rec = { starts: [], updates: [], stops: 0, offs: 0, pcm: null };
  return { rec, api: {
    appAudioStatus: async () => ({ supported: true, os: '10.0.19045', build: 19045 }),
    appAudioStart: async (cfg) => { rec.starts.push(JSON.parse(JSON.stringify(cfg))); return { rate: 48000, channels: 2, bits: 16 }; },
    appAudioUpdate: async (cfg) => { rec.updates.push(JSON.parse(JSON.stringify(cfg))); return true; },
    appAudioStop: async () => { rec.stops++; return true; },
    appAudioList: async () => ({ apps: APPS.map((a) => ({ ...a })) }),
    appAudioTest: async () => ({ ok: true, app: 'Google Chrome', format: 'PCM16/44100 evt+nopersist dur=200000', samples: 4800, peak: 900 }),
    onAppAudioPcm: (fn) => { rec.pcm = fn; return () => { rec.offs++; }; },
    ...over } };
}
const rows = (t) => t.$('#mixerList').children.filter((c) => (c.className || '').startsWith('mixrow'));
const rowOf = (t, name) => rows(t).find((r) => r.children[1].children[0].textContent === name);
const swOf = (row) => row.children[3].children[0];
const flip = (row, on) => { const sw = swOf(row); sw.checked = on; sw.fire('change'); };

test('áudio por aplicativo é a 1ª escolha: helper iniciado, AudioWorklet, sem pedir loopback do Chromium', async () => {
  const { rec, api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.enter();
  await t.shareFirstSource();
  assert.equal(rec.starts.length, 1); assert.equal(rec.starts[0].allowNew, true); assert.deepEqual(rec.starts[0].blocked, []);
  assert.equal(t.gdm.filter((c) => c.audio).length, 0, 'nenhum getDisplayMedia com áudio');
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.equal(t.$('#btnMixer').classList.contains('active'), true);
  const ctx = t.audioCtxs.find((c) => c.modules.length); assert.deepEqual(ctx.modules, ['pcm-worklet.js']); assert.equal(ctx.opts.sampleRate, 48000);
  const node = t.worklets[0]; assert.equal(node.name, 'vb-pcm'); assert.deepEqual([...node.opts.outputChannelCount], [2]);
});
test('PCM do helper chega ao worklet (sem cópia extra) e o ouvinte é removido ao desligar o áudio', async () => {
  const { rec, api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.enter(); t.msg({ t: 'hello', r: 'zzzzzzzzzzzzzzzz', name: 'Zé' }); await t.tick(4);
  await t.shareFirstSource();
  const u8 = new Uint8Array(1920); u8[0] = 7; rec.pcm(u8);
  const ab = t.worklets[0].posted[0]; assert.equal(ab.byteLength, 1920); assert.equal(new Uint8Array(ab)[0], 7);
  assert.equal(t.pcs[0].senders.length, 2, 'tela + faixa do áudio vão para os participantes');
  const big = new Uint8Array(new ArrayBuffer(4000), 100, 800); big[0] = 9; rec.pcm(big); assert.equal(t.worklets[0].posted[1].byteLength, 800, 'respeita o recorte do buffer');
  t.$('#btnSys').click(); await t.tick(8);
  assert.equal(rec.offs, 1); assert.equal(rec.stops, 1); assert.equal(t.audioCtxs.find((c) => c.modules.length).closed, true); assert.equal(t.pcs[0].senders.length, 1, 'só a tela continua');
});
test('helper falha ao iniciar: cai no áudio do sistema inteiro e avisa (com o motivo e o risco de eco)', async () => {
  const { rec, api } = nativeApi({ appAudioStart: async () => { throw new Error('o helper encerrou: ActivateAudioInterfaceAsync falhou (HRESULT 0x80070057)'); } });
  const t = boot({ vbOverrides: api }); await t.enter(); await t.shareFirstSource();
  assert.equal(t.$('#btnSys').classList.contains('active'), true, 'o áudio do sistema inteiro entrou');
  assert.equal(t.gdm.filter((c) => c.audio).length, 1);
  const m = t.$('#msg').textContent; assert.match(m, /Áudio por aplicativo indisponível \(o helper encerrou: ActivateAudioInterfaceAsync falhou/); assert.match(m, /voz dos outros participantes pode voltar/);
  assert.equal(rec.offs, 1, 'ouvinte removido'); assert.equal(t.audioCtxs.find((c) => c.modules.length).closed, true);
  t.$('#btnMixer').click(); await t.tick(8); assert.match(t.$('#mixerStatus').textContent, /sistema inteiro/);
});
test('worklet que não carrega também cai no modo sistema inteiro', async () => {
  const { api } = nativeApi(); const t = boot({ vbOverrides: api, media: { workletFails: true } }); await t.enter(); await t.shareFirstSource();
  assert.match(t.$('#msg').textContent, /Áudio por aplicativo indisponível \(addModule falhou\)/); assert.equal(t.$('#btnSys').classList.contains('active'), true);
});
test('Windows sem suporte (ou desligado nas configurações): cai no modo atual sem alarme', async () => {
  const old = nativeApi({ appAudioStatus: async () => ({ supported: false, reason: 'Requer Windows 10 versão 2004 (build 19041) ou mais novo; este PC está na build 18363.' }) });
  const t = boot({ vbOverrides: old.api }); await t.enter(); await t.shareFirstSource();
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.doesNotMatch(t.$('#msg').textContent, /por aplicativo/);
  t.$('#btnMixer').click(); await t.tick(8); assert.match(t.$('#mixerStatus').textContent, /sistema inteiro.*build 18363/);
  const off = nativeApi(); let asked = 0; const cfg = boot().config; cfg.appAudio = { enabled: false, allowNew: true, blocked: [], allowed: [] };
  const u = boot({ cfg, vbOverrides: { ...off.api, appAudioStatus: async () => { asked++; return { supported: true }; } } }); await u.enter(); await u.shareFirstSource();
  assert.equal(asked, 0, 'desativado: nem consulta o helper'); assert.equal(off.rec.starts.length, 0); assert.equal(u.$('#btnSys').classList.contains('active'), true);
});

// ===================== painel do mixer =====================
test('mixer: abre com 🎚, lista os aplicativos com áudio, medidores e estado de cada um', async () => {
  const { api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.enter();
  t.$('#btnMixer').click(); await t.tick(10);
  assert.equal(t.$('#mixer').classList.contains('hidden'), false);
  assert.deepEqual(rows(t).map((r) => r.children[1].children[0].textContent), ['Google Chrome', 'Spotify', 'Discord']);
  assert.ok(rows(t).every((r) => swOf(r).checked), 'novos aplicativos entram ligados por padrão');
  assert.equal(rowOf(t, 'Google Chrome').children[2].children[0].style.width, Math.round(Math.sqrt(0.5) * 100) + '%');
  assert.match(t.$('#mixerStatus').textContent, /só é transmitido junto com uma tela compartilhada/);
});
test('mixer: desligar o Chrome grava a escolha (config) e vale ao ligar o áudio; religar remove o bloqueio', async () => {
  const { rec, api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.enter(); t.$('#btnMixer').click(); await t.tick(10);
  flip(rowOf(t, 'Google Chrome'), false); await t.tick(3);
  assert.deepEqual([...t.calls.filter((c) => c[0] === 'setConfig').pop()[1].appAudio.blocked], ['chrome.exe']);
  assert.ok(rowOf(t, 'Google Chrome').className.includes('off')); assert.equal(rec.updates.length, 0, 'sem captura ativa não há o que atualizar');
  t.$('#mixer').fire('click'); await t.shareFirstSource();
  assert.deepEqual(rec.starts[0].blocked, ['chrome.exe'], 'o helper já nasce sem o Chrome');
  flip(rowOf(t, 'Google Chrome'), true); await t.tick(3);
  assert.deepEqual([...t.calls.filter((c) => c[0] === 'setConfig').pop()[1].appAudio.blocked], []);
});
test('mixer ao vivo: com a captura ativa, cada mudança vai ao helper na hora e a lista vem dos eventos', async () => {
  const { rec, api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.enter(); await t.shareFirstSource();
  t.$('#btnMixer').click(); await t.tick(8);
  t.handlers.onAppAudioEvent({ event: 'apps', apps: APPS.map((a) => ({ ...a, included: true, capturing: true })) }); await t.tick(2);
  assert.equal(rows(t).length, 3); assert.match(t.$('#mixerStatus').textContent, /Transmitindo por aplicativo/);
  flip(rowOf(t, 'Google Chrome'), false); await t.tick(3);
  assert.deepEqual(rec.updates.pop().blocked, ['chrome.exe']);
  const spotify = rowOf(t, 'Spotify');
  t.handlers.onAppAudioEvent({ event: 'apps', apps: APPS.map((a) => ({ ...a, peak: 0.9, included: true })) }); await t.tick(2);
  assert.equal(rowOf(t, 'Spotify'), spotify, 'só os medidores mudam: as linhas não são recriadas (o clique não se perde)');
  assert.equal(spotify.children[2].children[0].style.width, Math.round(Math.sqrt(0.9) * 100) + '%');
  t.handlers.onAppAudioEvent({ event: 'apps', apps: [...APPS, { key: 'game.exe', name: 'Meu Jogo', pid: 9, active: true, peak: 0.3 }] }); await t.tick(2);
  const game = rowOf(t, 'Meu Jogo'); assert.ok(game && swOf(game).checked);
});
test('"novos aplicativos entram transmitindo": desligar mantém os atuais ligados; um app novo nasce desligado e pode ser ligado', async () => {
  const { rec, api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.enter(); await t.shareFirstSource(); t.$('#btnMixer').click(); await t.tick(8);
  t.handlers.onAppAudioEvent({ event: 'apps', apps: APPS }); await t.tick(2);
  t.$('#mixNew').checked = false; t.$('#mixNew').fire('change'); await t.tick(3);
  let a = rec.updates.pop(); assert.equal(a.allowNew, false); assert.deepEqual([...a.allowed].sort(), ['chrome.exe', 'discord.exe', 'spotify.exe']);
  t.handlers.onAppAudioEvent({ event: 'apps', apps: [...APPS, { key: 'game.exe', name: 'Meu Jogo', pid: 9, active: true, peak: 0.3 }] }); await t.tick(2);
  assert.equal(swOf(rowOf(t, 'Meu Jogo')).checked, false, 'novo app começa mudo'); assert.equal(swOf(rowOf(t, 'Spotify')).checked, true);
  flip(rowOf(t, 'Meu Jogo'), true); await t.tick(3); a = rec.updates.pop(); assert.ok(a.allowed.includes('game.exe'));
  flip(rowOf(t, 'Spotify'), false); await t.tick(3); a = rec.updates.pop(); assert.deepEqual([...a.blocked], ['spotify.exe']); assert.ok(!a.allowed.includes('spotify.exe'));
});
test('aplicativos bloqueados que não estão abertos continuam na lista (para poder religar)', async () => {
  const cfg = boot().config; cfg.appAudio = { enabled: true, allowNew: true, blocked: ['zoom.exe'], allowed: [] };
  const { api } = nativeApi(); const t = boot({ cfg, vbOverrides: api }); await t.enter(); t.$('#btnMixer').click(); await t.tick(10);
  const z = rowOf(t, 'zoom.exe'); assert.ok(z.className.includes('gone')); assert.match(z.children[1].children[1].textContent, /fora de uso/); assert.equal(swOf(z).checked, false);
  flip(z, true); await t.tick(3); assert.deepEqual([...t.calls.filter((c) => c[0] === 'setConfig').pop()[1].appAudio.blocked], []);
});
test('mixer: sem aplicativos mostra a orientação; erros de listagem aparecem; fechar para de consultar', async () => {
  const none = nativeApi({ appAudioList: async () => ({ apps: [] }) }); const t = boot({ vbOverrides: none.api }); await t.enter(); t.$('#btnMixer').click(); await t.tick(10);
  assert.match(t.$('#mixerList').children[0].textContent, /Nenhum aplicativo está tocando áudio/);
  const bad = nativeApi({ appAudioList: async () => { throw new Error('GetDefaultAudioEndpoint falhou (HRESULT 0x80070490)'); } }); const u = boot({ vbOverrides: bad.api }); await u.enter(); u.$('#btnMixer').click(); await u.tick(10);
  assert.match(u.$('#mixerStatus').textContent, /Não foi possível listar.*0x80070490/);
  u.ctx.document.l.click(); assert.equal(u.$('#mixer').classList.contains('hidden'), true, 'clicar fora fecha');
  const calls = () => u.calls.filter((c) => c[0] === 'appAudioList').length; const n = calls(); await wait(1700); assert.equal(calls(), n, 'fechado: sem consultas');
});
test('o helper parar sozinho derruba só o áudio (com aviso), nunca a sala; erro de captura de um app aparece na linha dele', async () => {
  const { rec, api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.enter(); await t.shareFirstSource(); t.$('#btnMixer').click(); await t.tick(8);
  t.handlers.onAppAudioEvent({ event: 'apps', apps: APPS }); await t.tick(2);
  t.handlers.onAppAudioEvent({ event: 'capture_error', app: 'spotify.exe', message: 'IAudioClient.Initialize falhou (HRESULT 0x88890008)' }); await t.tick(2);
  assert.match(rowOf(t, 'Spotify').children[1].children[1].textContent, /⚠ IAudioClient\.Initialize falhou/);
  assert.ok(t.calls.some((c) => c[0] === 'log' && c[2] === 'App capture failed'));
  t.handlers.onAppAudioEvent({ event: 'exit', code: 1, error: 'boom' }); await t.tick(6);
  assert.match(t.$('#msg').textContent, /helper de áudio por aplicativo parou/); assert.equal(t.$('#btnSys').classList.contains('active'), false);
  assert.equal(rec.stops, 1); assert.equal(t.$('#roomView').classList.contains('hidden'), false);
});
test('configurações: o interruptor de áudio por aplicativo é salvo e as escolhas por app sobrevivem ao salvar', async () => {
  const cfg = boot().config; cfg.appAudio = { enabled: true, allowNew: false, blocked: ['chrome.exe'], allowed: ['spotify.exe'] };
  const t = boot({ cfg }); await t.tick(4); t.$('#btnSettings').click(); await t.tick(4);
  assert.equal(t.$('#appAudioOn').checked, true); assert.equal(t.$('#mixNew').checked, false);
  t.$('#appAudioOn').checked = false; t.$('#btnSave').click(); await t.tick(3);
  const saved = t.calls.filter((c) => c[0] === 'setConfig').pop()[1].appAudio;
  assert.equal(saved.enabled, false); assert.deepEqual([...saved.blocked], ['chrome.exe']); assert.deepEqual([...saved.allowed], ['spotify.exe']); assert.equal(saved.allowNew, false);
});
test('diagnóstico: mostra o suporte, testa a captura por processo e explica quando não há suporte', async () => {
  const { api } = nativeApi(); const t = boot({ vbOverrides: api }); await t.tick(3); t.$('#btnLobbySettings').click(); await t.tick(3); t.$('#btnDiag').click(); await t.tick(16);
  const d = t.$('#diag').textContent; assert.match(d, /Áudio por aplicativo: OK \(Windows 10\.0\.19045\)/); assert.match(d, /teste de captura por processo: OK \(Google Chrome; formato PCM16\/44100 evt\+nopersist dur=200000; amostras 4800, pico 900\)/);
  const bad = nativeApi({ appAudioStatus: async () => ({ supported: false, reason: 'csc.exe não encontrado' }) }); const u = boot({ vbOverrides: bad.api }); await u.tick(3); u.$('#btnLobbySettings').click(); await u.tick(3); u.$('#btnDiag').click(); await u.tick(16);
  assert.match(u.$('#diag').textContent, /Áudio por aplicativo: indisponível: csc\.exe não encontrado/);
  const none = nativeApi({ appAudioTest: async () => ({ ok: false, none: true, error: 'x' }) }); const v = boot({ vbOverrides: none.api }); await v.tick(3); v.$('#btnLobbySettings').click(); await v.tick(3); v.$('#btnDiag').click(); await v.tick(16);
  assert.match(v.$('#diag').textContent, /abra um aplicativo com áudio para testar/);
});

test('diagnóstico: quando a captura por processo falha, mostra o HRESULT de cada combinação testada', async () => {
  const { api } = nativeApi({ appAudioTest: async () => ({ ok: false, app: 'Google Chrome', error: 'IAudioClient.Initialize falhou em todas as 20 combinacoes de formato/flags: 0x88890021 (AUDCLNT_E_INVALID_STREAM_FLAG) x20', probe: ['PCM16/44100 evt+nopersist dur=200000 → 0x88890008 (AUDCLNT_E_UNSUPPORTED_FORMAT)', 'PCM16/48000 evt+autoconv dur=0 → 0x88890021 (AUDCLNT_E_INVALID_STREAM_FLAG)'] }) });
  const t = boot({ vbOverrides: api }); await t.tick(3); t.$('#btnLobbySettings').click(); await t.tick(3); t.$('#btnDiag').click(); await t.tick(16);
  const d = t.$('#diag').textContent;
  assert.match(d, /teste de captura por processo: FALHOU \(Google Chrome\): IAudioClient\.Initialize falhou em todas as 20 combinacoes/);
  assert.match(d, /tentativas \(formato \/ flags → resultado do Windows\):\n\s+PCM16\/44100 evt\+nopersist dur=200000 → 0x88890008 \(AUDCLNT_E_UNSUPPORTED_FORMAT\)\n\s+PCM16\/48000 evt\+autoconv dur=0 → 0x88890021/);
});
