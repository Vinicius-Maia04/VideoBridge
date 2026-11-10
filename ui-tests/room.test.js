const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/room-harness');

const LOW = '0000000000000000', HIGH = 'zzzzzzzzzzzzzzzz'; // < e > de qualquer ID aleatório

test('carrega a configuração salva nos campos (nome, webhook, caixas, relay, qualidade)', async () => {
  const t = boot({ cfg: { hostName: 'João', resolution: 720, fps: 60, bitrate: 5500, codec: 'VP9', priority: 'motion', systemAudio: false,
    mic: { enabled: false, deviceId: '', gain: 1.5 }, webcam: { enabled: false, deviceId: '' }, stun: [], signaling: { relay: 'https://r.example', maxParticipants: 4 },
    discord: { announce: true, webhookUrl: 'https://hook', joinPageUrl: 'https://p.example/x' }, sfx: { enabled: false, volume: 0.2 }, hotkeys: {}, autostart: true, startMinimized: false } });
  await t.tick(3);
  assert.equal(t.$('#lobbyName').value, 'João'); assert.equal(t.$('#dcUrl').value, 'https://hook'); assert.equal(t.$('#joinPage').value, 'https://p.example/x');
  assert.equal(t.$('#dcOn').checked, true); assert.equal(t.$('#autostart').checked, true); assert.equal(t.$('#minimized').checked, false);
  assert.equal(t.$('#relayUrl').value, 'https://r.example'); assert.equal(t.$('#maxParticipants').value, 4);
  assert.equal(t.$('#sfxOn').checked, false); assert.equal(t.$('#sfxVol').value, 0.2);
  assert.equal(t.$('#res').value, '720'); assert.equal(t.$('#fps').value, '60'); assert.equal(t.$('#bitrate').value, 'custom'); assert.equal(t.$('#bitrateCustom').value, 5500);
  assert.equal(t.$('#presetVideo').classList.contains('sel'), true);
});
test('Salvar envia os valores digitados (nome, webhook, relay, página-ponte)', async () => {
  const t = boot(); await t.tick(3);
  t.$('#btnSettings').click(); await t.tick(3);
  t.$('#myName').value = 'Maria'; t.$('#dcUrl').value = 'https://hook2'; t.$('#minimized').checked = true; t.$('#relayUrl').value = 'https://meu.relay'; t.$('#joinPage').value = 'https://p.example/j'; t.$('#maxParticipants').value = 4; t.$('#sfxOn').checked = false; t.$('#sfxVol').value = 0.3;
  t.$('#btnSave').click(); await t.tick(3);
  const saved = t.calls.filter((c) => c[0] === 'setConfig').pop()[1];
  assert.equal(saved.hostName, 'Maria'); assert.equal(saved.discord.webhookUrl, 'https://hook2'); assert.equal(saved.startMinimized, true);
  assert.equal(saved.signaling.relay, 'https://meu.relay'); assert.equal(saved.discord.joinPageUrl, 'https://p.example/j'); assert.equal(saved.signaling.maxParticipants, 4); assert.equal(saved.sfx.enabled, false); assert.equal(saved.sfx.volume, 0.3);
  assert.match(t.$('#settingsMsg').textContent, /salvas/);
});
test('lobby -> criar sala: mostra a sala, copia o link e só manda "hello" quando o relay está live', async () => {
  const t = boot(); await t.tick(3); t.$('#lobbyName').value = 'João'; t.$('#btnCreate').click(); await t.tick(8);
  assert.equal(t.$('#lobby').classList.contains('hidden'), true); assert.equal(t.$('#roomView').classList.contains('hidden'), false);
  const open = t.calls.find((c) => c[0] === 'sigOpen'); assert.equal(open[1], null); assert.match(open[2], /^[A-Za-z0-9_-]{6,32}$/);
  assert.ok(t.calls.some((c) => c[0] === 'copy' && c[1] === 'VB2.AAAAAAAAAAAAAAAAAAAAAA'));
  assert.equal(t.sent('hello').length, 0, 'antes do live não pode enviar (perderia respostas)');
  t.status('live'); await t.tick(4);
  assert.equal(t.sent('hello').length, 1); assert.equal(t.sent('hello')[0].name, 'João');
  t.status('live'); await t.tick(2); assert.equal(t.sent('hello').length, 1, 'não repete');
  assert.match(t.$('#participants').children[0].children[1].textContent, /João \(você\)/);
});
test('entrar com código e por deep link (room:invite)', async () => {
  const t = boot(); await t.enter({ code: 'VB2.BBBBBBBBBBBBBBBBBBBBBB' });
  assert.equal(t.calls.find((c) => c[0] === 'sigOpen')[1], 'VB2.BBBBBBBBBBBBBBBBBBBBBB');
  const u = boot(); await u.tick(3); u.handlers.onInvite('videobridge://join/VB2.CCCCCCCCCCCCCCCCCCCCCC'); await u.tick(8);
  assert.equal(u.calls.find((c) => c[0] === 'sigOpen')[1], 'videobridge://join/VB2.CCCCCCCCCCCCCCCCCCCCCC'); assert.equal(u.$('#roomView').classList.contains('hidden'), false);
});
test('falha ao abrir a sala volta ao lobby com mensagem', async () => {
  const t = boot({ vbOverrides: { sigOpen: async () => { throw new Error('Código de convite inválido.'); } } });
  await t.tick(3); t.$('#codeIn').value = 'lixo'; t.$('#btnJoin').click(); await t.tick(8);
  assert.match(t.$('#lobbyMsg').textContent, /inválido/); assert.equal(t.$('#roomView').classList.contains('hidden'), true);
});

test('compartilhar tela: seletor -> captura -> prévia local SEM áudio, contador e estado da bandeja', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource();
  assert.deepEqual(t.gdm.map((c) => !!c.audio), [false, true], 'vídeo primeiro (sem áudio), áudio do sistema à parte');
  const tile = t.$('#tiles').children[0]; assert.ok(tile); assert.equal(tile.children[0].children[0].muted, true);
  assert.equal(t.$('#screenCount').textContent, '+ 1');
  assert.ok(t.calls.some((c) => c[0] === 'setStreamState' && c[1] === 'STREAMING'));
  assert.equal(t.$('#emptyStage').classList.contains('hidden'), true);
  tile.children[1].children.at(-1).click(); await t.tick(4); // botão Parar do tile
  assert.equal(t.$('#tiles').children.length, 0); assert.equal(t.$('#emptyStage').classList.contains('hidden'), false);
  assert.ok(t.calls.filter((c) => c[0] === 'setStreamState').pop()[1] === 'IDLE');
});
test('erro de "audio source": o vídeo NÃO depende do áudio; tenta de novo e, se persistir, avisa e registra', async () => {
  const t = boot({ media: { audioFails: true } }); await t.enter(); await t.shareFirstSource();
  assert.equal(t.$('#tiles').children.length, 1, 'a tela foi compartilhada mesmo assim');
  assert.equal(t.gdm.filter((c) => c.audio).length, 3, '3 tentativas espaçadas do loopback');
  assert.match(t.$('#msg').textContent, /Áudio do sistema indisponível/); assert.match(t.$('#msg').textContent, /tela continua sendo compartilhada/);
  assert.ok(t.calls.some((c) => c[0] === 'log' && c[1] === 'error' && c[2] === 'System audio failed'));
  assert.equal(t.$('#btnSys').classList.contains('active'), false);
});
test('erro intermitente do áudio do sistema: a 2ª tentativa funciona e o áudio entra sem aviso de erro', async () => {
  const t = boot({ media: { audioFailTimes: 1 } }); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5);
  await t.shareFirstSource();
  assert.equal(t.gdm.filter((c) => c.audio).length, 2); assert.equal(t.$('#btnSys').classList.contains('active'), true);
  assert.doesNotMatch(t.$('#msg').textContent, /indisponível/);
  assert.equal(t.pcs[0].senders.length, 2, 'vídeo + áudio do sistema enviados');
});
test('estratégia alternativa (API antiga) salva quando o loopback normal falha sempre', async () => {
  const t = boot({ media: { audioFails: true, legacyOk: true } }); await t.enter(); await t.shareFirstSource();
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.doesNotMatch(t.$('#msg').textContent, /indisponível/);
});
test('botão 🔊: com a tela no ar liga/desliga só o áudio; sem tela ele fica desativado', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5);
  assert.equal(t.$('#btnSys').disabled, true, 'sem tela não há como transmitir só o áudio');
  await t.shareFirstSource({ audio: false }); assert.equal(t.$('#btnSys').disabled, false); assert.equal(t.$('#btnSys').classList.contains('active'), false);
  const base = t.pcs[0].senders.length;
  t.$('#btnSys').click(); await t.tick(14); await t.tick(6);
  assert.equal(t.$('#btnSys').classList.contains('active'), true); assert.equal(t.pcs[0].senders.length, base + 1); assert.equal(t.$('#tiles').children.length, 1, 'a tela continua');
  t.$('#btnSys').click(); await t.tick(8); assert.equal(t.$('#btnSys').classList.contains('active'), false); assert.equal(t.pcs[0].senders.length, base);
});
test('só um loopback de áudio por vez: a segunda tela não pede outro áudio do sistema', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource(); await t.shareFirstSource();
  assert.equal(t.gdm.filter((c) => c.audio).length, 1); assert.equal(t.$('#screenCount').textContent, '+ 2');
});
test('hello de quem tem ID menor/maior: o iniciador (menor ID) abre a conexão sozinho', async () => {
  const t = boot(); await t.enter(); const me = t.myId();
  t.msg({ t: 'hello', r: HIGH, name: 'Zé' }); await t.tick(6); // eu < HIGH -> eu inicio
  assert.equal(t.pcs.length, 1); assert.ok(t.pcs[0].hasDc);
  const hello = t.sent('hello').find((m) => m.to === HIGH); assert.ok(hello, 'responde ao recém-chegado');
  const offer = t.sent('desc').find((m) => m.to === HIGH); assert.equal(offer.desc.type, 'offer'); assert.match(offer.desc.sdp, /^v=0/);
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(6); // LOW < eu -> espero a oferta dela
  assert.equal(t.pcs.length, 2); assert.ok(!t.pcs[1].hasDc); assert.equal(t.sent('desc').filter((m) => m.to === LOW).length, 0);
  assert.equal(t.$('#peopleCount').textContent, '3'); assert.ok(me);
});
test('recebe oferta, responde, cria o tile com o nome da fonte e remove quando a fonte some', async () => {
  const t = boot(); await t.enter();
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4);
  const stream = t.makeStream('remoteScr', { audio: true });
  const sdp = 'v=0\r\na=vbfake:' + Buffer.from(JSON.stringify({ tracks: stream._tracks.map((x) => ({ sid: 'remoteScr', id: x.id, kind: x.kind })) })).toString('base64') + '\r\n';
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp }, meta: [{ sid: 'remoteScr', label: 'Jogo', kind: 'screen', audio: true }], muted: false });
  await t.tick(10);
  const ans = t.sent('desc').find((m) => m.desc.type === 'answer'); assert.ok(ans); assert.equal(ans.to, LOW);
  assert.equal(t.$('#tiles').children.length, 1); assert.equal(t.$('#emptyStage').classList.contains('hidden'), true);
  assert.equal(t.$('#tiles').children[0].children[1].children[0].textContent, 'Ana — Jogo');
  assert.match(t.$('#participants').children.at(-1).children.at(-1).textContent, /🖥/);
  // renegociação sem a fonte -> tile some
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: 'v=0\r\n' }, meta: [], muted: false }); await t.tick(8);
  assert.equal(t.$('#tiles').children.length, 0); assert.equal(t.$('#emptyStage').classList.contains('hidden'), false);
});
test('colisão de ofertas: o "polite" (ID maior) desfaz a sua e responde; o "impolite" ignora', async () => {
  const t = boot(); await t.enter();
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(3);   // LOW < eu  => eu sou polite
  t.pcs[0].signalingState = 'have-local-offer';
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: 'v=0\r\n' }, meta: [] }); await t.tick(8);
  assert.ok(t.sent('desc').some((m) => m.to === LOW && m.desc.type === 'answer'), 'polite responde');
  t.msg({ t: 'hello', r: HIGH, name: 'Zé' }); await t.tick(8);   // eu < HIGH => eu sou impolite
  const before = t.sent('desc').filter((m) => m.desc.type === 'answer').length;
  const pc = t.pcs[1]; pc.signalingState = 'have-local-offer';
  t.msg({ t: 'desc', r: HIGH, to: t.myId(), desc: { type: 'offer', sdp: 'v=0\r\n' }, meta: [] }); await t.tick(8);
  assert.equal(t.sent('desc').filter((m) => m.desc.type === 'answer').length, before, 'impolite ignora');
});
test('compartilhar com gente na sala adiciona a track em cada conexão e renegocia sozinho (sem convite novo)', async () => {
  const t = boot(); await t.enter();
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); t.msg({ t: 'hello', r: HIGH, name: 'Zé' }); await t.tick(8);
  t.msg({ t: 'desc', r: HIGH, to: t.myId(), desc: { type: 'answer', sdp: 'v=0\r\n' }, meta: [] }); await t.tick(3); // handshake inicial completo
  t.calls.length = 0;
  await t.shareFirstSource();
  assert.equal(t.pcs[0].senders.length, 2); assert.equal(t.pcs[1].senders.length, 2); // vídeo + áudio do sistema
  await t.tick(8);
  // os pares respondem à oferta da tela; só então o WebRTC renegocia o áudio que entrou logo depois (comportamento real)
  for (const r of [LOW, HIGH]) t.msg({ t: 'desc', r, to: t.myId(), desc: { type: 'answer', sdp: 'v=0\r\n' }, meta: [] });
  await t.tick(10);
  const descs = t.sent('desc'); assert.ok(descs.some((m) => m.to === LOW) && descs.some((m) => m.to === HIGH));
  for (const to of [LOW, HIGH]) { const last = descs.filter((m) => m.to === to).pop(); assert.ok(last.meta.some((x) => x.kind === 'screen') && last.meta.some((x) => x.kind === 'sysaudio'), 'a última descrição leva tela + áudio'); }
  t.calls.length = 0; // parar a (única) tela remove o vídeo E o áudio do sistema juntos, e renegocia
  t.$('#tiles').children[0].children[1].children.at(-1).click(); await t.tick(8);
  assert.equal(t.pcs[0].senders.length, 0); assert.equal(t.$('#btnSys').classList.contains('active'), false);
  assert.ok(t.sent('desc').every((m) => m.meta.length === 0), 'ninguém fica só com o áudio no ar');
});
test('limite de participantes: quem passa do limite recebe "full"; ao receber "full" volta ao lobby', async () => {
  const cfg = boot().config; cfg.signaling = { relay: 'https://ntfy.sh', maxParticipants: 2 };
  const t = boot({ cfg }); await t.enter();
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); t.msg({ t: 'hello', r: HIGH, name: 'Zé' }); await t.tick(6);
  assert.equal(t.pcs.length, 1); assert.match(t.sent('full')[0].reason, /lotada/); assert.equal(t.sent('full')[0].to, HIGH);
  const u = boot(); await u.enter(); u.msg({ t: 'full', r: LOW, to: u.myId(), reason: 'A sala está lotada (6 participantes).' }); await u.tick(8);
  assert.equal(u.$('#roomView').classList.contains('hidden'), true); assert.match(u.$('#lobbyMsg').textContent, /lotada/);
});
test('mensagens inválidas, de si mesmo ou para outro participante são ignoradas', async () => {
  const t = boot(); await t.enter();
  for (const m of [null, {}, { t: 5 }, { t: 'hello' }, { t: 'hello', r: '../x' }, { t: 'hello', r: t.myId() }, { t: 'hello', r: LOW, to: 'outroqualquer1' }, { t: 'desc', r: LOW, to: t.myId(), desc: { type: 'x', sdp: 'v=0' } }]) t.msg(m);
  await t.tick(6); assert.equal(t.$('#peopleCount').textContent, '2'.replace('2', String(t.pcs.length + 1)));
  assert.equal(t.sent('desc').length, 0);
});
test('bye remove o participante e os tiles dele; conexão "failed" também', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); t.msg({ t: 'hello', r: HIGH, name: 'Zé' }); await t.tick(6);
  assert.equal(t.$('#peopleCount').textContent, '3');
  t.msg({ t: 'bye', r: LOW }); await t.tick(2); assert.equal(t.$('#peopleCount').textContent, '2');
  t.pcs[1].setState('failed'); await t.tick(2); assert.equal(t.$('#peopleCount').textContent, '1'); assert.match(t.$('#msg').textContent, /conexão P2P direta/);
});
test('microfone: 1º clique pede o dispositivo e envia; 2º muta e avisa os outros (sem renegociar)', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5);
  assert.equal(t.$('#btnMic').classList.contains('off'), true);
  t.$('#btnMic').click(); await t.tick(8);
  assert.equal(t.$('#btnMic').classList.contains('off'), false); assert.equal(t.pcs[0].senders.length, 1);
  assert.equal(t.sent('status').pop().muted, false);
  t.$('#btnMic').click(); await t.tick(4);
  assert.equal(t.$('#btnMic').classList.contains('off'), true); assert.equal(t.sent('status').pop().muted, true); assert.equal(t.pcs[0].senders.length, 1);
});
test('microfone indisponível mostra erro claro e não quebra a sala', async () => {
  const t = boot({ media: { micFails: true } }); await t.enter(); t.$('#btnMic').click(); await t.tick(8);
  assert.match(t.$('#msg').textContent, /Microfone indisponível/); assert.equal(t.$('#roomView').classList.contains('hidden'), false);
});
test('câmera liga/desliga durante a sala (tile + track)', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5);
  t.$('#btnCam').click(); await t.tick(8);
  assert.equal(t.$('#tiles').children.length, 1); assert.equal(t.pcs[0].senders.length, 1);
  t.$('#btnCam').click(); await t.tick(6);
  assert.equal(t.$('#tiles').children.length, 0); assert.equal(t.pcs[0].senders.length, 0);
});
test('"ouvir os outros" (fone) silencia o áudio remoto (mic e áudio do sistema)', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4);
  const sdp = 'v=0\r\na=vbfake:' + Buffer.from(JSON.stringify({ tracks: [{ sid: 's9', id: 't9', kind: 'video' }, { sid: 'a9', id: 't10', kind: 'audio' }] })).toString('base64') + '\r\n';
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp }, meta: [{ sid: 's9', label: 'Tela', kind: 'screen' }, { sid: 'a9', label: 'Áudio do sistema', kind: 'sysaudio' }] }); await t.tick(8);
  const audio = [...t.$('#tiles').children].map((x) => x.children[0].children[0]).find((v) => v.srcObject && v.srcObject.id === 'a9'); assert.ok(audio);
  assert.equal(audio.muted, false);
  t.$('#btnDeaf').click(); assert.equal(audio.muted, true); t.$('#btnDeaf').click(); assert.equal(audio.muted, false);
  const video = t.$('#tiles').children[0].children[0].children[0]; assert.equal(video.muted, true, 'vídeo de tela nunca toca áudio: o som vem da fonte dedicada');
});
test('painel de qualidade: preset aplica resolução/fps/prioridade e atualiza os encoders na hora', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(5); await t.shareFirstSource(); t.pcs[0].setState('connected'); await t.tick(4);
  t.$('#presetVideo').click(); await t.tick(6);
  assert.equal(t.$('#fps').value, '60'); const saved = t.calls.filter((c) => c[0] === 'setConfig').pop()[1];
  assert.equal(saved.fps, 60); assert.equal(saved.priority, 'motion');
  const v = t.pcs[0].senders.find((s) => s.track.kind === 'video'); assert.equal(v.params.encodings[0].maxFramerate, 60);
  t.$('#bitrate').value = '6000'; t.$('#bitrate').fire('change'); await t.tick(4);
  assert.equal(v.params.encodings[0].maxBitrate, 6000 * 1000);
  t.$('#btnGear').click(); assert.equal(t.$('#quality').classList.contains('hidden'), false);
});
test('Discord: o convite sai na CRIAÇÃO da sala (sem fontes), atualiza ao compartilhar e só some quando a sala acaba', async () => {
  const cfg = boot().config; cfg.discord = { announce: true, webhookUrl: 'https://hook', joinPageUrl: '' };
  const t = boot({ cfg, vbOverrides: { sigOpen: async () => ({ code: 'VB3.AAAAAAAAAAAAAAAAAAAAAA', joinUrl: 'https://p.example/#VB3.AAAAAAAAAAAAAAAAAAAAAA' }), discordAnnounce: async () => 'msg1', discordUpdate: async () => true } });
  await t.enter(); await t.tick(6);
  const a = t.calls.find((c) => c[0] === 'discordAnnounce'); assert.ok(a, 'criar a sala já avisa');
  assert.equal(a[1].sources.length, 0); assert.equal(a[1].joinUrl, 'https://p.example/#VB3.AAAAAAAAAAAAAAAAAAAAAA');
  await t.shareFirstSource();
  const u = t.calls.filter((c) => c[0] === 'discordUpdate').pop(); assert.ok(u, 'atualiza quando passa a compartilhar'); assert.match(u[1].sources[0], /Tela 1/);
  const ends = () => t.calls.filter((c) => c[0] === 'discordEnd').length;
  t.$('#tiles').children[0].children[1].children.at(-1).click(); await t.tick(8);
  assert.equal(ends(), 0, 'parar de compartilhar NÃO apaga o convite: a sala continua aberta');
  assert.equal(t.calls.filter((c) => c[0] === 'discordAnnounce').length, 1, 'um único aviso por sala');
  t.$('#btnLeave').click(); await t.tick(10);
  assert.equal(ends() > 0, true, 'sair da sala apaga o aviso');
});
const dcBoot = (extra = {}) => {
  const cfg = boot().config; cfg.discord = { announce: true, webhookUrl: 'https://hook', joinPageUrl: '' };
  return boot({ cfg, vbOverrides: { sigOpen: async () => ({ code: 'VB3.AAAAAAAAAAAAAAAAAAAAAA', joinUrl: 'https://p.example/#VB3.AAAAAAAAAAAAAAAAAAAAAA' }), discordAnnounce: async () => 'msg1', discordUpdate: async () => true, ...extra } });
};
test('Discord: o MESMO aviso passa a listar quem entrou na sala e o que cada um compartilha', async () => {
  const t = dcBoot(); await t.enter(); await t.tick(6);
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(6);
  t.msg({ t: 'desc', r: LOW, to: t.myId(), desc: { type: 'offer', sdp: 'v=0\r\n' }, meta: [{ sid: 'remoteScr', label: 'Jogo', kind: 'screen' }, { sid: 'remoteSys', label: 'Sistema', kind: 'sysaudio' }], muted: false }); await t.tick(10);
  const u = t.calls.filter((c) => c[0] === 'discordUpdate').pop(); assert.ok(u, 'editou o aviso existente');
  assert.equal(t.calls.filter((c) => c[0] === 'discordAnnounce').length, 1, 'continua sendo uma única mensagem');
  assert.ok(u[1].sources.some((x) => /^Ana: .*Jogo \+ 🔊/.test(x)), JSON.stringify(u[1].sources));
  assert.equal(u[1].people, 2);
});
test('Discord: quem apenas ENTRA na sala não cria aviso (nem compartilhando)', async () => {
  const t = dcBoot(); await t.enter({ code: 'VB3.AAAAAAAAAAAAAAAAAAAAAA' }); await t.tick(8);
  await t.shareFirstSource(); await t.tick(8);
  assert.equal(t.calls.filter((c) => c[0] === 'discordAnnounce').length, 0);
});
test('Discord: o dono que sai com a sala cheia passa a mensagem; se alguém assume, ela NÃO é apagada', async () => {
  const t = dcBoot({ discordHandoffInfo: async () => ({ webhookId: '123456789012345678', messageId: '987654321098765432', started: 1700000000 }) });
  await t.enter(); await t.tick(6); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(6);
  t.$('#btnLeave').click(); await t.tick(4);
  assert.ok(t.sent('dc_handoff').length === 1, 'oferece a mensagem à sala');
  t.msg({ t: 'dc_adopted', r: LOW }); await new Promise((r) => setTimeout(r, 400)); await t.tick(20);
  assert.ok(t.calls.some((c) => c[0] === 'discordRelease'), 'larga sem apagar');
});
test('Discord: se ninguém assume o aviso, o dono apaga ao sair', async () => {
  const t = dcBoot({ discordHandoffInfo: async () => ({ webhookId: '123456789012345678', messageId: '987654321098765432', started: 1 }) });
  await t.enter(); await t.tick(6); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(6);
  t.$('#btnLeave').click(); await new Promise((r) => setTimeout(r, 2800)); await t.tick(10);
  assert.ok(t.calls.some((c) => c[0] === 'discordEnd'));
  assert.ok(!t.calls.some((c) => c[0] === 'discordRelease'));
});
test('Discord: quem tem o mesmo webhook assume quando o dono sai (e avisa a sala)', async () => {
  const t = dcBoot({ discordAdopt: async () => true }); // sou só um participante (sala criada por outro)
  await t.enter({ code: 'VB3.AAAAAAAAAAAAAAAAAAAAAA' }); await t.tick(6);
  t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(6);
  t.msg({ t: 'dc_handoff', r: LOW, webhookId: '123456789012345678', messageId: '987654321098765432', started: 5 });
  await new Promise((r) => setTimeout(r, 1500)); await t.tick(10);
  assert.ok(t.calls.some((c) => c[0] === 'discordAdopt' && c[1].messageId === '987654321098765432'));
  assert.equal(t.sent('dc_adopted').length, 1, 'avisa a sala que assumiu');
});
test('sair: avisa (bye), fecha o relay, solta as fontes e volta ao lobby', async () => {
  const t = boot(); await t.enter(); t.msg({ t: 'hello', r: LOW, name: 'Ana' }); await t.tick(4); await t.shareFirstSource();
  const tracks = t.pcs[0].senders.map((s) => s.track);
  t.$('#btnLeave').click(); await t.tick(10);
  assert.equal(t.sent('bye').length, 1); assert.equal(t.sent('closed').length, 0, 'não era o último: só "bye"'); assert.ok(t.calls.some((c) => c[0] === 'sigClose')); assert.ok(t.pcs[0].closed); assert.ok(tracks.every((x) => x.stopped));
  assert.equal(t.$('#lobby').classList.contains('hidden'), false); assert.equal(t.$('#tiles').children.length, 0);
  t.$('#btnCreate').click(); await t.tick(6); assert.equal(t.calls.filter((c) => c[0] === 'sigOpen').length, 2, 'dá para criar outra sala');
});
test('atalhos: compartilhar/parar tela, câmera e mic', async () => {
  const t = boot(); await t.enter(); await t.shareFirstSource();
  t.handlers.onHotkey('toggleStream'); await t.tick(6); assert.equal(t.$('#tiles').children.length, 0);
  t.handlers.onHotkey('toggleCamera'); await t.tick(6); assert.equal(t.$('#tiles').children.length, 1);
  t.handlers.onHotkey('stopShare'); await t.tick(6); assert.equal(t.$('#tiles').children.length, 0);
  t.handlers.onHotkey('toggleMic'); await t.tick(6); assert.equal(t.$('#btnMic').classList.contains('off'), false);
});
test('diagnóstico inclui o relay e funciona no lobby', async () => {
  const t = boot({ vbOverrides: { sigSelfTest: async () => ({ ok: true, ms: 120, relay: 'https://ntfy.sh' }) } }); await t.tick(3);
  t.$('#btnLobbySettings').click(); await t.tick(3); t.$('#btnDiag').click(); await t.tick(12);
  assert.match(t.$('#diag').textContent, /WebRTC: OK/); assert.match(t.$('#diag').textContent, /Relay de signaling: OK \(120 ms\)/); assert.match(t.$('#diag').textContent, /Áudio do sistema pelo Chromium \(modo alternativo\): saída padrão «desconhecida»[^\n]*\n\s+loopback: OK/);
});
