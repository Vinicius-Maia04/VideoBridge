/** Controles de espectador, sons e ciclo de vida da sala (sala encerrada). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/room-harness');

const LOW = '0000000000000000', HIGH = 'zzzzzzzzzzzzzzzz';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const btn = (tile, text) => tile.children[1].children.find((c) => c.textContent === text);
const offerSdp = (tracks) => 'v=0\r\na=vbfake:' + Buffer.from(JSON.stringify({ tracks })).toString('base64') + '\r\n';
const remoteScreen = async (t, { audio = false } = {}) => {
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4);
  const tracks = [{ sid: 'rs1', id: 'rt1', kind: 'video' }, ...(audio ? [{ sid: 'ra1', id: 'rt2', kind: 'audio' }] : [])];
  const meta = [{ sid: 'rs1', label: 'Jogo', kind: 'screen' }, ...(audio ? [{ sid: 'ra1', label: 'Áudio do sistema', kind: 'sysaudio' }] : [])];
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: offerSdp(tracks) }, meta }); await t.tick(10);
  return [...t.$('#tiles').children].find((x) => x.children[1].children[0].textContent === 'Ana — Jogo');
};

// ===================== tela cheia, foco, zoom, volume =====================
test('tela cheia: o botão ⛶ e o duplo clique pedem tela cheia do cartão inteiro', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource();
  const tile = t.$('#tiles').children[0]; let calls = 0; tile.requestFullscreen = () => { calls++; return Promise.resolve(); };
  btn(tile, '⛶').click(); assert.equal(calls, 1);
  tile.children[0].fire('dblclick'); assert.equal(calls, 2);
  tile.requestFullscreen = () => Promise.reject(new Error('negado')); btn(tile, '⛶').click(); await t.tick(3);
  assert.match(t.$('#msg').textContent, /tela cheia/);
});
test('o shell Rust mantém a página sem throttling e com autoplay (equivale ao backgroundThrottling:false do Electron)', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'crates/vb-app/src/app.rs'), 'utf8');
  assert.match(app, /--autoplay-policy=no-user-gesture-required/);
  assert.match(app, /--disable-renderer-backgrounding/);
  assert.match(app, /with_navigation_handler/);
});
test('zoom: botões +/−, roda do mouse no ponto do cursor, arrastar e voltar a 100%', async () => {
  const t = boot(); await t.enter();
  const tile = await remoteScreen(t); const video = tile.children[0].children[0], wrap = tile.children[0];
  assert.equal(video.style.transform, '');
  btn(tile, '+').click(); assert.match(video.style.transform, /scale\(1\.25\)/); assert.ok(btn(tile, '125%'));
  btn(tile, '+').click(); assert.match(video.style.transform, /scale\(1\.5625\)/);
  btn(tile, '−').click(); btn(tile, '−').click(); assert.equal(video.style.transform, '', 'volta ao normal sem sobra');
  wrap.fire('wheel', { deltaY: -100, clientX: 600, clientY: 100, preventDefault() {} }); assert.match(video.style.transform, /scale\(1\.2\)/);
  assert.equal(wrap.classList.contains('zoomed'), true);
  wrap.fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 }); wrap.fire('pointermove', { clientX: 60, clientY: 90 }); wrap.fire('pointerup', {});
  assert.match(video.style.transform, /translate\(-?[\d.]+px, -?[\d.]+px\)/);
  btn(tile, '120%').click(); assert.equal(video.style.transform, ''); assert.equal(wrap.classList.contains('zoomed'), false);
});
test('foco: destaca uma transmissão, as outras viram miniaturas; clicar na miniatura troca o foco', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource(); t.$('#btnCam').click(); await t.tick(8);
  const [a, b] = t.$('#tiles').children; assert.ok(a && b);
  assert.equal(t.$('#tiles').classList.contains('has-focus'), false);
  btn(b, 'Focar').click();
  assert.equal(t.$('#tiles').classList.contains('has-focus'), true); assert.equal(b.classList.contains('focused'), true); assert.equal(a.classList.contains('thumb'), true);
  assert.ok(btn(b, 'Sair do foco'));
  a.click(); assert.equal(a.classList.contains('focused'), true); assert.equal(b.classList.contains('thumb'), true);
  btn(a, 'Sair do foco').click(); assert.equal(t.$('#tiles').classList.contains('has-focus'), false);
  btn(a, 'Focar').click(); a.children[1].children.at(-1).click(); await t.tick(6); // para a tela focada
  assert.equal(t.$('#tiles').classList.contains('has-focus'), false, 'sem a transmissão focada o foco é desfeito');
});
test('volume/mudo da transmissão controla o áudio do sistema de quem compartilha; só aparece se houver áudio', async () => {
  const t = boot(); await t.enter(); const tile = await remoteScreen(t, { audio: true });
  const group = tile.children[1].children[1]; assert.equal(group.classList.contains('hidden'), false);
  const sys = [...t.$('#tiles').children].map((x) => x.children[0].children[0]).find((v) => v.srcObject.id === 'ra1');
  assert.equal(sys.volume, 1); assert.equal(sys.muted, false);
  group.children[0].click(); assert.equal(sys.muted, true); assert.equal(group.children[0].textContent, '🔇');
  group.children[1].value = '0.4'; group.children[1].fire('input'); assert.equal(sys.volume, 0.4); assert.equal(sys.muted, false);
  const sem = boot(); await sem.enter(); const t2 = await remoteScreen(sem, { audio: false });
  assert.equal(t2.children[1].children[1].classList.contains('hidden'), true, 'sem áudio do sistema, sem controle de volume');
});
test('volume por pessoa: slider do microfone na lista de participantes', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4);
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: offerSdp([{ sid: 'm1', id: 'mt1', kind: 'audio' }]) }, meta: [{ sid: 'm1', label: 'Microfone', kind: 'mic' }] }); await t.tick(10);
  const mic = t.$('#tiles').children.map((x) => x.children[0].children[0]).find((v) => v.srcObject.id === 'm1'); assert.ok(mic);
  const row = t.$('#participants').children.at(-1), slider = row.children.find((c) => c.className === 'pvol');
  assert.ok(slider); slider.value = '0.25'; slider.fire('input'); assert.equal(mic.volume, 0.25);
});

// ===================== sons =====================
test('sons: entrar, participante entra/sai, compartilhar/parar, câmera, mic, fone e sair', async () => {
  const t = boot(); t.clock.freeze(); await t.enter();
  assert.deepEqual([...t.sounds()], ['enter']);
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4); assert.equal(t.sounds().at(-1), 'peerJoin');
  await t.shareFirstSource(); assert.ok(t.sounds().includes('shareStart'));
  t.$('#tiles').children[0].children[1].children.at(-1).click(); await t.tick(6); assert.equal(t.sounds().filter((x) => x === 'shareStop').length, 1);
  t.$('#btnCam').click(); await t.tick(8); assert.ok(t.sounds().includes('camOn')); t.clock.advance(130);
  t.$('#btnCam').click(); await t.tick(6); assert.ok(t.sounds().includes('camOff'));
  t.$('#btnMic').click(); await t.tick(8); assert.ok(t.sounds().includes('micOn')); t.clock.advance(130);
  t.$('#btnMic').click(); await t.tick(4); assert.ok(t.sounds().includes('micOff'));
  t.$('#btnDeaf').click(); assert.ok(t.sounds().includes('deafOn')); t.clock.advance(130); t.$('#btnDeaf').click(); assert.ok(t.sounds().includes('deafOff'));
  t.msg({ t: 'bye', r: LOW }); await t.tick(3); assert.ok(t.sounds().includes('peerLeave'));
  t.$('#btnLeave').click(); await t.tick(8); assert.equal(t.sounds().at(-1), 'leave');
});
test('sons de participantes remotos: compartilhar/parar e câmera de OUTRA pessoa', async () => {
  const t = boot(); await t.enter(); const tile = await remoteScreen(t); assert.ok(tile);
  assert.ok(t.sounds().includes('shareStart'));
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: 'v=0\r\n' }, meta: [{ sid: 'rc', label: 'Câmera', kind: 'camera' }] }); await t.tick(8);
  assert.ok(t.sounds().includes('shareStop') && t.sounds().includes('camOn'));
});
test('sons: desligados nas configurações, silenciados com o fone e sem rajada do mesmo som', async () => {
  const off = boot(); off.clock.freeze(); off.config.sfx.enabled = false; await off.enter(); off.msg({ t: 'hello', r: LOW, name: 'Ana' }); await off.tick(4);
  assert.equal(off.sounds().length, 0);
  const t = boot(); t.clock.freeze(); await t.enter(); t.$('#btnDeaf').click(); const antes = t.sounds().length;
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4); assert.equal(t.sounds().length, antes, 'com o fone desligado não toca som de participante');
  const u = boot(); u.clock.freeze(); await u.enter(); u.clock.advance(500); u.msg({ t: 'hello', r: LOW, name: 'A' }); u.msg({ t: 'hello', r: HIGH, name: 'B' }); await u.tick(5);
  assert.equal(u.sounds().filter((x) => x === 'peerJoin').length, 1, 'dois "entrou" em <120 ms tocam uma vez');
  u.clock.advance(130); u.msg({ t: 'hello', r: 'yyyyyyyyyyyyyyyy', name: 'C' }); await u.tick(3);
  assert.equal(u.sounds().filter((x) => x === 'peerJoin').length, 2, 'passados 120 ms, toca de novo');
});
test('sons: erros tocam o som de erro e o botão "Testar" toca mesmo com a caixa desmarcada', async () => {
  const t = boot({ media: { micFails: true } }); await t.enter(); t.$('#btnMic').click(); await t.tick(8);
  assert.ok(t.sounds().includes('error'));
  const u = boot(); await u.tick(3); u.$('#sfxOn').checked = false; u.$('#btnSfxTest').click(); assert.equal([...u.sounds()].join(), 'enter');
});

// ===================== sala encerrada =====================
test('último a sair ENCERRA a sala (closed); quem sai com outros presentes só diz bye', async () => {
  const t = boot(); await t.enter(); t.$('#btnLeave').click(); await t.tick(8);
  assert.equal(t.sent('closed').length, 1); assert.equal(t.sent('bye').length, 0);
});
test('código de sala encerrada é recusado na entrada (histórico contém closed)', async () => {
  const t = boot(); await t.tick(3); t.$('#codeIn').value = 'VB2.AAAAAAAAAAAAAAAAAAAAAA'; t.$('#btnJoin').click(); await t.tick(6);
  t.status('closed'); await t.tick(6);
  assert.equal(t.$('#roomView').classList.contains('hidden'), true); assert.match(t.$('#lobbyMsg').textContent, /já foi encerrada/);
  assert.equal(t.sent('hello').length, 0, 'nem chega a anunciar presença'); assert.equal(t.sent('bye').length + t.sent('closed').length, 0);
  assert.ok(t.calls.some((c) => c[0] === 'sigClose'));
});
test('status "closed" entregue durante a abertura da sala também é respeitado', async () => {
  let t; t = boot({ vbOverrides: { sigOpen: async () => { t.status('closed'); return { code: 'VB2.AAAAAAAAAAAAAAAAAAAAAA', joinUrl: '' }; } } }); await t.tick(3);
  t.$('#codeIn').value = 'VB2.AAAAAAAAAAAAAAAAAAAAAA'; t.$('#btnJoin').click(); await t.tick(8);
  assert.match(t.$('#lobbyMsg').textContent, /já foi encerrada/); assert.equal(t.sent('hello').length, 0);
});
test('sala sem ninguém (crash dos outros): quem entra com código e não recebe resposta é recusado; o criador não', async () => {
  const j = boot({ joinWaitMs: 60 }); await j.enter({ code: 'VB2.BBBBBBBBBBBBBBBBBBBBBB' }); await wait(140); await j.tick(4);
  assert.equal(j.$('#roomView').classList.contains('hidden'), true); assert.match(j.$('#lobbyMsg').textContent, /não existe mais/);
  const c = boot({ joinWaitMs: 60 }); await c.enter(); await wait(140); await c.tick(3);
  assert.equal(c.$('#roomView').classList.contains('hidden'), false, 'o criador fica esperando os amigos');
  const k = boot({ joinWaitMs: 60 }); await k.enter({ code: 'VB2.BBBBBBBBBBBBBBBBBBBBBB' }); k.msg({ t: 'hello', r: LOW, name: 'Ana' }); await wait(140); await k.tick(3);
  assert.equal(k.$('#roomView').classList.contains('hidden'), false, 'se alguém responde, a sala existe');
});
test('"closed" ao vivo do único outro participante encerra a sala também para mim', async () => {
  const t = boot(); await t.enter({ code: 'VB2.BBBBBBBBBBBBBBBBBBBBBB' }); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4);
  t.msg({ t: 'closed', r: LOW }); await t.tick(6);
  assert.equal(t.$('#roomView').classList.contains('hidden'), true); assert.match(t.$('#lobbyMsg').textContent, /encerrada/);
});
test('o renderer informa o processo principal se está sozinho (para encerrar a sala ao fechar a janela)', async () => {
  const t = boot(); await t.enter(); await t.tick(2);
  const alone = () => t.calls.filter((c) => c[0] === 'setAlone').map((c) => c[1]);
  assert.equal(alone().at(-1), true);
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4); assert.equal(alone().at(-1), false);
  t.msg({ t: 'bye', r: LOW }); await t.tick(3); assert.equal(alone().at(-1), true);
});

test('mensagens atrasadas de quem já saiu (bye) não recriam um participante "fantasma"', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4);
  assert.equal(t.$('#peopleCount').textContent, '2');
  t.msg({ t: 'bye', r: LOW }); await t.tick(3); assert.equal(t.$('#peopleCount').textContent, '1');
  // chegam depois do bye (negociação/hello que ainda estavam em trânsito)
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: offerSdp([{ sid: 'x', id: 'x1', kind: 'video' }]) }, meta: [{ sid: 'x', label: 'Câmera', kind: 'camera' }] });
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); t.msg({ t: 'status', r: LOW, muted: false }); await t.tick(8);
  assert.equal(t.$('#peopleCount').textContent, '1'); assert.equal(t.$('#tiles').children.length, 0); assert.equal(t.pcs.length, 1, 'nenhuma conexão nova');
});

// ===================== áudio do sistema: diagnóstico do ambiente e alternativa =====================
const OUT = (label) => ({ kind: 'audiooutput', deviceId: 'default', label });
test('áudio do sistema falha com saída padrão VIRTUAL: a mensagem aponta o dispositivo e o que fazer', async () => {
  const t = boot({ media: { audioFails: true, devices: [OUT('Default - Alto-falantes (Voicemod Virtual Audio Device (WDM))')] } }); await t.enter(); await t.shareFirstSource();
  const m = t.$('#msg').textContent;
  assert.match(m, /Áudio do sistema indisponível \(NotReadableError: Could not start audio source\)/); assert.match(m, /tela continua sendo compartilhada/);
  assert.match(m, /«Alto-falantes \(Voicemod Virtual Audio Device \(WDM\)\)»/); assert.match(m, /dispositivo virtual/); assert.match(m, /alto-falantes\/fone reais/);
  const log = t.calls.find((c) => c[0] === 'log' && c[2] === 'System audio failed')[3];
  assert.equal(log.virtualOutput, true); assert.match(log.defaultOutput, /Voicemod/);
});
test('áudio do sistema falha com saída comum: orienta som espacial, 2 canais e modo exclusivo (sem culpar dispositivo virtual)', async () => {
  const t = boot({ media: { audioFails: true, devices: [OUT('Default - Alto-falantes (Realtek(R) Audio)')] } }); await t.enter(); await t.shareFirstSource();
  const m = t.$('#msg').textContent;
  assert.match(m, /«Alto-falantes \(Realtek\(R\) Audio\)»/); assert.match(m, /som espacial/); assert.match(m, /2 canais/); assert.match(m, /modo exclusivo/); assert.doesNotMatch(m, /dispositivo virtual/);
  assert.match(m, /Áudio do sistema \(alternativa\)/);
  const m2 = boot({ media: { audioFails: true } }); await m2.enter(); await m2.shareFirstSource(); assert.match(m2.$('#msg').textContent, /som espacial/, 'mesmo sem rótulos de dispositivo');
});
test('dispositivo alternativo configurado salva o áudio quando o loopback falha', async () => {
  const cfg = boot().config; cfg.systemAudioDevice = 'cabo1';
  const t = boot({ cfg, media: { audioFails: true, sysDeviceIds: ['cabo1'], devices: [{ kind: 'audioinput', deviceId: 'cabo1', label: 'CABLE Output (VB-Audio Virtual Cable)' }] } });
  await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4); await t.shareFirstSource();
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.doesNotMatch(t.$('#msg').textContent, /indisponível/);
  assert.equal(t.media.deviceRequests[0].audio.deviceId.exact, 'cabo1'); assert.equal(t.media.deviceRequests[0].audio.echoCancellation, false, 'sem processamento de voz no áudio do sistema');
  assert.equal(t.pcs[0].senders.length, 2);
});
test('"Mixagem estéreo" é detectada sozinha como alternativa quando o loopback falha', async () => {
  const t = boot({ media: { audioFails: true, sysDeviceIds: ['mix1'], devices: [{ kind: 'audioinput', deviceId: 'mix1', label: 'Mixagem estéreo (Realtek(R) Audio)' }, { kind: 'audioinput', deviceId: 'mic1', label: 'Microfone (USB)' }] } });
  await t.enter(); await t.shareFirstSource();
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.equal(t.media.deviceRequests[0].audio.deviceId.exact, 'mix1');
});
test('o loopback do Windows continua sendo a 1ª escolha: o dispositivo alternativo não é usado se ele funciona', async () => {
  const t = boot({ media: { sysDeviceIds: ['mix1'], devices: [{ kind: 'audioinput', deviceId: 'mix1', label: 'Stereo Mix' }] } }); await t.enter(); await t.shareFirstSource();
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.equal((t.media.deviceRequests || []).length, 0);
});
test('diagnóstico mostra a saída padrão, aponta dispositivo virtual e testa cada estratégia', async () => {
  const t = boot({ media: { audioFails: true, devices: [OUT('Default - Alto-falantes (Voicemod Virtual Audio Device (WDM))')] } }); await t.tick(3);
  t.$('#btnLobbySettings').click(); await t.tick(3); t.$('#btnDiag').click(); await t.tick(14);
  const d = t.$('#diag').textContent;
  assert.match(d, /saída padrão «Alto-falantes \(Voicemod Virtual Audio Device \(WDM\)\)» \(VIRTUAL: provável causa\)/); assert.match(d, /loopback: NotReadableError/); assert.match(d, /API antiga: NotSupportedError/);
});
test('configurações: lista dispositivos de gravação como alternativa e salva a escolha', async () => {
  const t = boot({ media: { devices: [{ kind: 'audioinput', deviceId: 'mix1', label: 'Mixagem estéreo' }] } }); await t.tick(4);
  t.$('#btnSettings').click(); await t.tick(4);
  const opts = t.$('#sysDev').children; assert.equal(opts[0].textContent, 'Automático (loopback do Windows)'); assert.ok(opts.some((o) => o.textContent === 'Mixagem estéreo'));
  t.$('#sysDev').value = 'mix1'; t.$('#btnSave').click(); await t.tick(3);
  assert.equal(t.calls.filter((c) => c[0] === 'setConfig').pop()[1].systemAudioDevice, 'mix1');
});

// ===================== conectividade: falha explicada, TURN, nomes =====================
const cand = (...c) => 'v=0\r\n' + c.map(([a, ty]) => `a=candidate:1 1 udp 2122260223 ${a} 50000 typ ${ty} generation 0\r\n`).join('');
test('conexão P2P que falha explica QUAL lado não achou endereço público e orienta o que fazer', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: HIGH, name: 'Beto' }); await t.tick(6);
  const pc = t.pcs[0]; pc.localDescription = { type: 'offer', sdp: cand(['x.local', 'host'], ['203.0.113.7', 'srflx']) }; pc.remote = { type: 'answer', sdp: cand(['y.local', 'host']) };
  pc.setState('failed'); await t.tick(2);
  const m = t.$('#msg').textContent;
  assert.match(m, /Beto: Não foi possível estabelecer uma conexão P2P direta\./); assert.match(m, /Sua rede: endereço público \(STUN\)\. Rede do outro participante: só endereço da rede local/);
  assert.match(m, /UDP\/STUN está bloqueado na rede dele/); assert.match(m, /sair e entrar na sala/);
  const log = t.calls.find((c) => c[0] === 'log' && c[2] === 'P2P connection failed')[3]; assert.equal(log.remote.srflx, 0); assert.equal(log.local.srflx, 1);
  assert.equal(t.$('#peopleCount').textContent, '1', 'a pessoa sai da lista');
});
test('falha com os dois lados com endereço público => NAT incompatível e sugestão de TURN', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: HIGH, name: 'Beto' }); await t.tick(6);
  const pc = t.pcs[0]; pc.localDescription = { type: 'offer', sdp: cand(['203.0.113.7', 'srflx']) }; pc.remote = { type: 'answer', sdp: cand(['198.51.100.2', 'srflx']) }; pc.setState('failed'); await t.tick(2);
  assert.match(t.$('#msg').textContent, /NAT incompatível.*CGNAT/); assert.match(t.$('#msg').textContent, /servidor TURN/);
});
test('sem nome digitado, cada pessoa recebe um nome padrão distinto (não tudo "Participante")', async () => {
  const ca = boot().config, cb = boot().config; ca.hostName = ''; cb.hostName = ''; const a = boot({ cfg: ca }), b = boot({ cfg: cb }); await a.tick(3); await b.tick(3); a.$('#lobbyName').value = ''; b.$('#lobbyName').value = ''; a.$('#btnCreate').click(); b.$('#btnCreate').click(); await a.tick(6); await b.tick(6);
  const na = a.$('#participants').children[0].children[1].textContent, nb = b.$('#participants').children[0].children[1].textContent;
  assert.match(na, /^Participante [A-Z0-9]{3} \(você\)$/); assert.notEqual(na, nb);
});
const TURN = { urls: 'turn:turn.exemplo.com:3478', username: 'joao', credential: 's3nha' };
test('TURN configurado entra nas conexões (junto do STUN) e é compartilhado com a sala no hello', async () => {
  const cfg = boot().config; cfg.turn = [TURN]; cfg.stun = ['stun:s.exemplo.com:3478'];
  const t = boot({ cfg }); await t.enter(); t.msg({ t: 'hello', r: HIGH, name: 'Beto' }); await t.tick(6);
  const servers = t.pcs[0].cfg.iceServers; assert.equal(JSON.stringify(servers.map((s) => s.urls)), JSON.stringify([['stun:s.exemplo.com:3478'], 'turn:turn.exemplo.com:3478'])); assert.equal(servers[1].username, 'joao'); assert.equal(servers[1].credential, 's3nha');
  const hellos = t.sent('hello'); assert.ok(hellos.length >= 1 && hellos.every((h) => h.turn && h.turn[0].urls === TURN.urls), 'todos os hello levam o TURN');
});
test('"compartilhar com a sala" desligado: o TURN fica só comigo', async () => {
  const cfg = boot().config; cfg.turn = [TURN]; cfg.shareTurn = false; const t = boot({ cfg }); await t.enter(); t.msg({ t: 'hello', r: HIGH, name: 'Beto' }); await t.tick(6);
  assert.ok(t.sent('hello').every((h) => !('turn' in h))); assert.ok(t.pcs[0].cfg.iceServers.some((s) => s.urls === TURN.urls), 'mas eu mesmo uso');
});
test('quem não tem TURN usa o de quem já está na sala (vindo no hello) nas conexões seguintes; dados inválidos são ignorados', async () => {
  const t = boot(); await t.enter();
  t.msg({ t: 'hello', r: LOW, name: 'Ana', turn: [TURN, { urls: 'http://evil.example', username: 'x', credential: 'y' }] }); await t.tick(6);
  assert.equal(JSON.stringify(t.pcs[0].cfg.iceServers.filter((s) => s.credential).map((s) => s.urls)), JSON.stringify([TURN.urls]));
  t.msg({ t: 'hello', r: HIGH, name: 'Zé' }); await t.tick(6); assert.ok(t.pcs[1].cfg.iceServers.some((s) => s.urls === TURN.urls), 'vale para as próximas conexões também');
  const u = boot(); await u.enter(); u.msg({ t: 'hello', r: LOW, name: 'Ana', turn: 'lixo' }); u.msg({ t: 'hello', r: HIGH, name: 'Zé', turn: [{ urls: 'javascript:alert(1)', username: 'a', credential: 'b' }] }); await u.tick(6);
  assert.ok(u.pcs.every((p) => p.cfg.iceServers.every((s) => !s.credential)), 'nada de TURN estranho');
});
test('sair da sala esquece o TURN recebido dos outros', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana', turn: [TURN] }); await t.tick(4);
  t.$('#btnLeave').click(); await t.tick(8); await t.enter(); t.msg({ t: 'hello', r: HIGH, name: 'Zé' }); await t.tick(6);
  assert.ok(t.pcs.at(-1).cfg.iceServers.every((s) => !s.credential));
});
test('configurações: TURN é carregado, salvo e linhas inválidas são avisadas (mas o resto é salvo)', async () => {
  const cfg = boot().config; cfg.turn = [TURN]; cfg.shareTurn = false; const t = boot({ cfg }); await t.tick(4); t.$('#btnSettings').click(); await t.tick(4);
  assert.equal(t.$('#turnLines').value, 'turn:turn.exemplo.com:3478|joao|s3nha'); assert.equal(t.$('#turnShare').checked, false);
  t.$('#turnLines').value = 'turn:a.com:3478|u|p\nlixo'; t.$('#turnShare').checked = true; t.$('#btnSave').click(); await t.tick(4);
  const saved = t.calls.filter((c) => c[0] === 'setConfig').pop()[1];
  assert.equal(saved.turn.length, 1); assert.equal(saved.turn[0].urls, 'turn:a.com:3478'); assert.equal(saved.shareTurn, true);
  assert.match(t.$('#settingsMsg').textContent, /ignorei linhas do TURN: Linha 2: URL inválida/);
});

// ===================== áudio do sistema vinculado à tela =====================
const stopTile = (t, i = 0) => t.$('#tiles').children[i].children[1].children.at(-1).click();
test('parar a ÚNICA tela encerra também o áudio do sistema (ninguém fica só com o áudio no ar)', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5); await t.shareFirstSource();
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.equal(t.pcs[0].senders.length, 2);
  for (let i = 0; i < 2; i++) { t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'answer', sdp: 'v=0\r\n' }, meta: [] }); await t.tick(8); } // o par responde às ofertas pendentes
  stopTile(t); await t.tick(8);
  assert.equal(t.$('#btnSys').classList.contains('active'), false); assert.equal(t.pcs[0].senders.length, 0); assert.equal(t.$('#btnScreen').classList.contains('active'), false);
  assert.equal(t.$('#btnSys').disabled, true, 'sem tela, o botão do áudio fica desativado');
  assert.ok(t.sent('desc').pop().meta.length === 0);
});
test('com duas telas, o áudio continua até parar a ÚLTIMA', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource(); await t.shareFirstSource();
  assert.equal(t.$('#screenCount').textContent, '+ 2'); assert.equal(t.$('#btnSys').classList.contains('active'), true);
  stopTile(t, 0); await t.tick(8); assert.equal(t.$('#btnSys').classList.contains('active'), true, 'ainda há uma tela');
  stopTile(t, 0); await t.tick(8); assert.equal(t.$('#btnSys').classList.contains('active'), false);
});
test('atalho de parar tela e "parar compartilhamento" também levam o áudio junto', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource(); t.handlers.onHotkey('toggleStream'); await t.tick(8);
  assert.equal(t.$('#btnSys').classList.contains('active'), false); assert.equal(t.$('#tiles').children.length, 0);
  await t.shareFirstSource(); t.handlers.onHotkey('stopShare'); await t.tick(8); assert.equal(t.$('#btnSys').classList.contains('active'), false);
});
test('janela compartilhada que fecha sozinha (tela encerrada pelo sistema) também derruba o áudio', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource();
  const track = t.$('#tiles').children[0].children[0].children[0].srcObject.getVideoTracks()[0]; (track.listeners.ended || []).forEach((f) => f());
  await t.tick(8); assert.equal(t.$('#btnSys').classList.contains('active'), false); assert.equal(t.$('#tiles').children.length, 0); assert.match(t.$('#msg').textContent, /foi encerrada/);
});
test('sem tela não dá para transmitir "só o áudio": botão desativado e a ação é recusada com explicação', async () => {
  const t = boot(); await t.enter();
  assert.equal(t.$('#btnSys').disabled, true); assert.match(t.$('#btnSys').title, /Compartilhe uma tela/);
  t.$('#btnSys').click(); await t.tick(10); // mesmo se o clique chegasse (atalho, bug), nada é capturado
  assert.equal(t.gdm.filter((c) => c.audio).length, 0); assert.equal(t.$('#btnSys').classList.contains('active'), false); assert.match(t.$('#msg').textContent, /só é transmitido junto com uma tela compartilhada/);
  await t.shareFirstSource({ audio: false }); assert.equal(t.$('#btnSys').disabled, false); assert.match(t.$('#btnSys').title, /junto com a sua tela/);
});
test('a tela para ENQUANTO o áudio ainda inicia: o áudio é descartado e nada vai ao ar', async () => {
  let release; const stops = { n: 0 };
  const api = { appAudioStatus: async () => ({ supported: true, os: '10.0.26200' }), appAudioStart: () => new Promise((r) => { release = r; }), appAudioStop: async () => { stops.n++; return true; }, appAudioUpdate: async () => true, appAudioList: async () => ({ apps: [] }), onAppAudioPcm: () => () => {} };
  const t = boot({ vbOverrides: api }); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5);
  t.$('#btnScreen').click(); await t.tick(4); t.$('#pickerList').children[0].children[1].children[0].click(); t.$('#pickerGo').click(); await t.tick(14); // tela no ar; helper ainda iniciando
  assert.equal(t.$('#btnSys').classList.contains('active'), false); stopTile(t); await t.tick(8);
  release({ rate: 48000, channels: 2 }); await t.tick(12);
  assert.equal(t.$('#btnSys').classList.contains('active'), false); assert.equal(t.pcs[0].senders.length, 0, 'nenhuma faixa de áudio sozinha'); assert.ok(stops.n >= 1, 'o helper é parado');
});
test('mesma proteção no modo "sistema inteiro" (tentativas do Chromium): tela parou durante as tentativas', async () => {
  const t = boot({ media: { audioFailTimes: 2 } }); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5);
  t.$('#btnScreen').click(); await t.tick(4); t.$('#pickerList').children[0].children[1].children[0].click(); t.$('#pickerGo').click(); await t.tick(8); stopTile(t); await wait(40); await t.tick(10);
  assert.equal(t.$('#btnSys').classList.contains('active'), false); assert.equal(t.pcs[0].senders.length, 0);
});
test('quem assiste: o áudio do sistema só toca se o outro participante tem TELA no ar (defesa contra clientes antigos)', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4);
  const sdp = offerSdp([{ sid: 'a9', id: 't10', kind: 'audio' }]);
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp }, meta: [{ sid: 'a9', label: 'Áudio do sistema', kind: 'sysaudio' }] }); await t.tick(8);
  const sys = t.$('#tiles').children.map((x) => x.children[0].children[0]).find((v) => v.srcObject.id === 'a9');
  assert.equal(sys.muted, true, 'só áudio, sem tela: não toca');
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: offerSdp([{ sid: 'a9', id: 't10', kind: 'audio' }, { sid: 'v9', id: 't11', kind: 'video' }]) }, meta: [{ sid: 'a9', label: 'Áudio do sistema', kind: 'sysaudio' }, { sid: 'v9', label: 'Jogo', kind: 'screen' }] }); await t.tick(8);
  assert.equal(sys.muted, false, 'com tela, toca');
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: 'v=0\r\n' }, meta: [{ sid: 'a9', label: 'Áudio do sistema', kind: 'sysaudio' }] }); await t.tick(8);
  assert.equal(sys.muted, true, 'a tela parou: o áudio para de tocar mesmo que o outro lado ainda o envie');
});

// ===================== seletor: telas inteiras x janelas =====================
const SOURCES = [{ id: 'window:7', name: 'Google Chrome', kind: 'window', thumb: '' }, { id: 'screen:1', name: 'Tela 1', kind: 'screen', thumb: '' }, { id: 'window:8', name: 'Minecraft', kind: 'window', thumb: '' }, { id: 'screen:2', name: 'Tela 2', kind: 'screen', thumb: '' }];
const sections = (t) => t.$('#pickerList').children.map((g) => ({ title: g.children[0].textContent, cards: (g.children[1].children || []).filter((c) => c.className === 'src'), note: g.children[1].textContent }));
test('seletor separa "Telas inteiras" de "Janelas", com contagem e rótulo em cada cartão', async () => {
  const t = boot({ vbOverrides: { listSources: async () => SOURCES.map((x) => ({ ...x })) } }); await t.enter(); t.$('#btnScreen').click(); await t.tick(6);
  const [screens, windows] = sections(t);
  assert.equal(screens.title, '🖥 Telas inteiras (2)'); assert.equal(windows.title, '🪟 Janelas (2)');
  assert.deepEqual(screens.cards.map((c) => c.children[1].textContent), ['Tela 1', 'Tela 2']); assert.deepEqual(windows.cards.map((c) => c.children[1].textContent), ['Google Chrome', 'Minecraft']);
  assert.ok(screens.cards.every((c) => c.children[2].textContent === '🖥 Tela inteira')); assert.ok(windows.cards.every((c) => c.children[2].textContent === '🪟 Janela'));
  assert.equal(t.$('#picker').classList.contains('hidden'), false);
});
test('seletor: seções vazias explicam; escolher uma tela e uma janela juntas compartilha as duas', async () => {
  const none = boot({ vbOverrides: { listSources: async () => [SOURCES[1]] } }); await none.enter(); none.$('#btnScreen').click(); await none.tick(6);
  const [s1, w1] = sections(none); assert.equal(s1.title, '🖥 Telas inteiras (1)'); assert.equal(w1.title, '🪟 Janelas (0)'); assert.match(w1.note, /Nenhuma janela aberta/);
  const t = boot({ vbOverrides: { listSources: async () => SOURCES.map((x) => ({ ...x })) } }); await t.enter(); t.$('#btnScreen').click(); await t.tick(6);
  const [screens, windows] = sections(t); screens.cards[0].click(); windows.cards[1].click(); t.$('#pickerAudio').checked = false; t.$('#pickerGo').click(); await t.tick(14);
  assert.equal(t.$('#screenCount').textContent, '+ 2'); assert.deepEqual(t.calls.filter((c) => c[0] === 'selectSource').map((c) => c[1]), ['screen:1', 'window:8']);
});
test('seletor: avisa que o áudio do sistema vai junto com a tela', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'ui/room.html'), 'utf8');
  assert.match(html, /transmitido <b>junto com a tela<\/b>/); assert.match(html, /id="btnSys"[^>]*disabled/);
});
