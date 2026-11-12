'use strict';
/**
 * Sala única (estilo "chamada"): todo participante pode compartilhar tela/câmera/microfone
 * e assistir aos outros. Malha P2P: uma RTCPeerConnection por par de participantes,
 * negociada de forma simétrica ("perfect negotiation") com signaling cifrado via relay.
 * O relay só serve para as pessoas se encontrarem; a mídia vai direto entre os PCs.
 */
// Tudo dentro de uma função: um `const vb` global colidiria com a propriedade
// `vb` não configurável criada pelo contextBridge (SyntaxError silencioso).
(() => {
const vb = window.vb, V = window.VB;
const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const RETRY_DELAYS = window.VB_RETRY_DELAYS || [0, 500, 1500]; // tentativas de capturar o áudio do sistema (espaçadas: o erro é intermitente)
const JOIN_WAIT_MS = window.VB_JOIN_WAIT_MS || 8000;           // quanto esperar alguém responder ao entrar com um código
const S = {
  cfg: null, myId: '', name: '', room: null, sigState: '', helloSent: false, preset: 'balanced', created: false, joinTimer: null, lastAlone: null,
  peers: new Map(), gone: new Set(), local: [], tiles: new Map(), vol: new Map(), focusKey: null,
  micItem: null, micMuted: false, micGainNode: null, deafened: false, sysBusy: false, sfxCtx: null,
  sharedTurn: [], apps: [], appStatus: null, nativeError: '', mixerTimer: null, mixerSig: '', meters: new Map(), appNotes: {},
  statsTimer: null, pickerSel: new Set(), pickerSources: [], discordChain: Promise.resolve(), discordOn: false,
};
const machine = V.createMachine(V.ROOM_STATES, 'LOBBY', () => render());
const randId = () => { const a = new Uint8Array(9); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16); };
const named = (name, msg) => Object.assign(new Error(msg), { name });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- efeitos sonoros (sintetizados; respeitam "ouvir os outros" desligado) ----------
const sfx = V.createSfx({
  getContext: () => {
    if (!S.sfxCtx) { try { S.sfxCtx = new AudioContext(); } catch { return null; } }
    if (S.sfxCtx.state === 'suspended' && S.sfxCtx.resume) S.sfxCtx.resume().catch(() => {});
    return S.sfxCtx;
  },
  getVolume: () => (S.cfg && S.cfg.sfx ? S.cfg.sfx.volume : 0.5),
  isEnabled: () => !S.cfg || !S.cfg.sfx || S.cfg.sfx.enabled !== false,
});
const sound = (name, force) => { if (S.deafened && !force) return; try { sfx.play(name); } catch { /* sem áudio disponível */ } };

let msgTimer = null;
/** Mensagens somem sozinhas (12 s; erros 20 s) para não ficarem "presas" na tela. */
const say = (t, cls = 'warn') => {
  const m = $('#msg'); m.textContent = t || ''; m.className = cls;
  clearTimeout(msgTimer);
  if (t) { msgTimer = setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, cls === 'err' ? 20000 : t.length > 160 ? 30000 : 12000); if (cls === 'err') sound('error'); }
};
const lobbySay = (t, cls = 'warn') => { const m = $('#lobbyMsg'); m.textContent = t || ''; m.className = cls; };
const icon = (kind) => (kind === 'screen' ? '🖥 ' : kind === 'camera' ? '📷 ' : kind === 'mic' ? '🎙 ' : '');
const hint = () => (S.cfg.priority === 'balanced' ? '' : S.cfg.priority);

// ---------- configuração <-> UI ----------
function uiToCfg() {
  const c = JSON.parse(JSON.stringify(S.cfg));
  c.hostName = $('#myName').value.trim();
  c.resolution = Number($('#res').value); c.fps = Number($('#fps').value);
  c.bitrate = $('#bitrate').value === 'auto' ? 'auto' : Number($('#bitrate').value === 'custom' ? $('#bitrateCustom').value : $('#bitrate').value);
  c.codec = $('#codec').value;
  c.priority = S.preset === 'text' ? 'detail' : S.preset === 'video' ? 'motion' : 'balanced';
  c.systemAudio = $('#sysAudio').checked; c.systemAudioDevice = $('#sysDev').value;
  c.mic = { enabled: false, deviceId: $('#micDev').value, gain: Number($('#micGain').value) };
  c.webcam = { enabled: false, deviceId: $('#camDev').value };
  c.discord = { announce: $('#dcOn').checked, webhookUrl: $('#dcUrl').value.trim(), joinPageUrl: $('#joinPage').value.trim(), presence: $('#dcPresence').checked };
  c.signaling = { relay: $('#relayUrl').value.trim(), maxParticipants: Number($('#maxParticipants').value) || 6 };
  c.autostart = $('#autostart').checked; c.startMinimized = $('#minimized').checked;
  c.sfx = { enabled: $('#sfxOn').checked, volume: Number($('#sfxVol').value) };
  c.appAudio = { ...appCfg(), enabled: $('#appAudioOn').checked };
  c.turn = V.parseTurnLines($('#turnLines').value).servers; c.shareTurn = $('#turnShare').checked;
  return c;
}
function cfgToUi(c) {
  $('#myName').value = c.hostName || ''; $('#lobbyName').value = c.hostName || '';
  $('#res').value = String(c.resolution); $('#fps').value = String(c.fps);
  const presets = ['auto', '2000', '4000', '6000', '8000', '10000'];
  if (presets.includes(String(c.bitrate))) $('#bitrate').value = String(c.bitrate);
  else { $('#bitrate').value = 'custom'; $('#bitrateCustom').value = c.bitrate; $('#bitrateCustom').classList.remove('hidden'); }
  $('#codec').value = c.codec; $('#sysAudio').checked = c.systemAudio;
  S.preset = c.priority === 'detail' ? 'text' : c.priority === 'motion' ? 'video' : 'balanced'; markPreset();
  $('#micGain').value = c.mic.gain;
  $('#dcPresence').checked = c.discord.presence !== false; $('#dcOn').checked = c.discord.announce; $('#dcUrl').value = c.discord.webhookUrl; $('#joinPage').value = c.discord.joinPageUrl || '';
  $('#relayUrl').value = (c.signaling && c.signaling.relay) || ''; $('#maxParticipants').value = (c.signaling && c.signaling.maxParticipants) || 6;
  $('#autostart').checked = c.autostart; $('#minimized').checked = c.startMinimized;
  $('#sfxOn').checked = !c.sfx || c.sfx.enabled !== false; $('#sfxVol').value = c.sfx ? c.sfx.volume : 0.5;
  $('#turnLines').value = V.formatTurnLines(c.turn || []); $('#turnShare').checked = c.shareTurn !== false;
  $('#appAudioOn').checked = !c.appAudio || c.appAudio.enabled !== false; $('#mixNew').checked = !c.appAudio || c.appAudio.allowNew !== false;
}
/** Escolhas por aplicativo (sempre com a forma completa, mesmo se a configuração antiga não tinha). */
function appCfg() {
  const a = S.cfg.appAudio = S.cfg.appAudio || {};
  if (typeof a.enabled !== 'boolean') a.enabled = true; if (typeof a.allowNew !== 'boolean') a.allowNew = true;
  if (!Array.isArray(a.blocked)) a.blocked = []; if (!Array.isArray(a.allowed)) a.allowed = [];
  return a;
}
const kbpsFor = (cfg, kind) => {
  const base = cfg.bitrate === 'auto' ? V.autoBitrateKbps(cfg.resolution, cfg.fps, cfg.codec) : cfg.bitrate;
  return kind === 'camera' ? Math.min(base, V.autoBitrateKbps(720, 30, cfg.codec)) : base;
};
async function saveCfg() { S.cfg = await vb.setConfig(uiToCfg()); return S.cfg; }

// ---------- dispositivos ----------
async function refreshDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, saved, first) => {
    const s = $(sel); s.textContent = '';
    if (first) s.append(el('option', { value: '', text: first }));
    devs.filter((d) => d.kind === kind).forEach((d, i) => s.append(el('option', { value: d.deviceId, text: d.label || `Dispositivo ${i + 1}` })));
    if (saved) s.value = saved;
  };
  fill('#camDev', 'videoinput', S.cfg.webcam.deviceId); fill('#micDev', 'audioinput', S.cfg.mic.deviceId);
  fill('#sysDev', 'audioinput', S.cfg.systemAudioDevice, 'Automático (loopback do Windows)');
}
navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices().catch(() => {}));

// ---------- captura (fontes opcionais nunca derrubam a sala) ----------
const getScreen = (w, h, fps, audio) => navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } }, audio });
/** getUserMedia com 2 tentativas: dispositivo escolhido e, se sumiu/mudou, o padrão do sistema. */
async function userMedia(kind, deviceId) {
  const base = kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
  const attempts = deviceId ? [{ ...base, deviceId: { exact: deviceId } }, base] : [base];
  let last;
  for (const c of attempts) {
    try { return await navigator.mediaDevices.getUserMedia({ [kind]: c }); }
    catch (e) { last = e; vb.log('warn', 'getUserMedia failed', { kind, name: e.name, error: e.message }); if (e.name === 'NotAllowedError') break; }
  }
  throw last;
}
/** O vídeo da tela NUNCA depende do áudio: o áudio do sistema é uma fonte à parte, com tentativas. */
async function startShares(ids, wantAudio) {
  const { w, h } = V.RESOLUTIONS[S.cfg.resolution];
  for (const id of ids) {
    const src = S.pickerSources.find((x) => x.id === id); if (!src) continue;
    await vb.selectSource(id, false);
    let stream;
    try { stream = await getScreen(w, h, S.cfg.fps, false); }
    catch (e) {
      vb.log('error', 'Screen capture failed', { label: src.name, name: e.name, error: e.message });
      say(e.name === 'NotAllowedError' ? 'Permissão negada para captura.' : `Não foi possível capturar "${src.name}": ${e.message}`, 'err'); continue;
    }
    const item = { sid: stream.id, label: src.name, kind: 'screen', audio: false, stream };
    stream.getVideoTracks().forEach((t) => { t.contentHint = hint(); t.addEventListener('ended', () => onLocalEnded(item)); });
    await addLocal(item);
  }
  if (wantAudio) await startSystemAudio();
}

// ---------- áudio do sistema (WASAPI loopback via Chromium) ----------
async function audioSourceId() {
  const list = await vb.listSources(false); // sem miniaturas: leve
  const scr = (list || []).find((x) => x.kind === 'screen') || (list || [])[0];
  return scr && scr.id;
}
const VIRTUAL_RE = /(voicemod|virtual|vb-?audio|cable|voicemeeter|hands-?free|bluetooth|hfp|steam streaming)/i;
const STEREO_MIX_RE = /(stereo mix|mixagem est[eé]reo|what u hear|o que você ouve|wave out)/i;
/** Descobre a saída padrão do Windows (o loopback captura ESSE dispositivo) e se há um dispositivo de gravação alternativo. */
async function audioEnv() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* sem permissão/dispositivos */ }
  const outs = devs.filter((d) => d.kind === 'audiooutput');
  const def = outs.find((d) => d.deviceId === 'default') || outs[0];
  const clean = (l) => String(l || '').replace(/^(default|padrão|predefinido)\s*-\s*/i, '').trim();
  const defaultOutput = def ? clean(def.label) : '';
  const inputs = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const auto = inputs.find((d) => STEREO_MIX_RE.test(d.label));
  return { defaultOutput, virtual: !!defaultOutput && VIRTUAL_RE.test(defaultOutput), altDeviceId: S.cfg.systemAudioDevice || (auto && auto.deviceId) || '' };
}
/** Orientação específica conforme o que foi detectado (a causa é o dispositivo de saída, não o app). */
function audioAdvice(env) {
  if (env.virtual) return `A saída de áudio padrão do Windows é «${env.defaultOutput}», que parece um dispositivo virtual (Voicemod, cabo virtual ou Bluetooth em modo "mãos livres"): o Windows não consegue capturar o som dele. Em Configurações do Windows → Sistema → Som, escolha seus alto-falantes/fone reais como saída padrão e tente de novo no botão 🔊.`;
  return `${env.defaultOutput ? `Saída padrão detectada: «${env.defaultOutput}». ` : ''}Confira nas propriedades dessa saída (Painel de Som → Reproduzir → Propriedades): desative o som espacial (Windows Sonic/Dolby Atmos), deixe o formato em 2 canais (estéreo, 48000 Hz) e desmarque o modo exclusivo. Se continuar, escolha uma alternativa em ⋮ Configurações → Áudio do sistema (alternativa).`;
}
/** Alternativa que não depende do loopback: um dispositivo de gravação que capture o som do PC. */
async function grabDevice(id) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
  const a = s.getAudioTracks();
  if (!a.length) throw named('NoAudioTrack', 'a captura não trouxe faixa de áudio');
  return a;
}
/** Pede o loopback junto de um vídeo mínimo (exigido pela API) que é descartado na hora. */
async function grabLoopback(id) {
  await vb.selectSource(id, true);
  const s = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 1, max: 5 } }, audio: true });
  s.getVideoTracks().forEach((t) => t.stop());
  const a = s.getAudioTracks();
  if (!a.length) throw named('NoAudioTrack', 'a captura não trouxe faixa de áudio');
  return a;
}
/** Alternativa (API antiga do Chromium para áudio da área de trabalho). */
async function grabLegacy(id) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 1 } } });
  s.getVideoTracks().forEach((t) => t.stop());
  const a = s.getAudioTracks();
  if (!a.length) throw named('NoAudioTrack', 'a captura não trouxe faixa de áudio');
  return a;
}
/**
 * Áudio POR APLICATIVO (helper nativo, Windows 10 2004+): cada app é capturado separadamente, só entram os que o
 * usuário deixou ligados e o próprio VideoBridge nunca é capturado (sem eco). O PCM chega por IPC e vira uma faixa
 * WebRTC via AudioWorklet. Devolve o item de fonte, ou null (com S.nativeError) para cair no modo "sistema inteiro".
 */
async function tryNativeAudio() {
  S.nativeError = ''; S.nativeFailed = false;
  if (appCfg().enabled === false) { S.nativeError = 'desativado nas configurações'; return null; }
  let st; try { st = await vb.appAudioStatus(); } catch (e) { st = { supported: false, reason: e.message }; }
  S.appStatus = st;
  if (!st || !st.supported) { S.nativeError = (st && st.reason) || 'indisponível neste computador'; return null; }
  let ctx = null, off = null;
  try {
    ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume();
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const node = new AudioWorkletNode(ctx, 'vb-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination(); node.connect(dest); // sem ligar aos alto-falantes: ninguém ouve duas vezes
    off = vb.onAppAudioPcm((u8) => { const ab = u8.buffer && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); node.port.postMessage(ab, [ab]); });
    await vb.appAudioStart(appCfg());
    const stream = dest.stream;
    return { sid: stream.id, label: 'Áudio do sistema', kind: 'sysaudio', audio: true, stream, native: true,
      cleanup: () => { try { off(); } catch { /* ok */ } vb.appAudioStop().catch(() => {}); ctx.close().catch(() => {}); } };
  } catch (e) {
    try { if (off) off(); } catch { /* ok */ } if (ctx) ctx.close().catch(() => {});
    S.nativeError = e.message; S.nativeFailed = true; // suportado, mas falhou: vale avisar (diferente de "não existe neste Windows")
    vb.log('warn', 'Per-app audio failed', { error: e.message });
    return null;
  }
}
/** O áudio do sistema pertence à TELA: nasce com ela e morre com ela. Sem tela compartilhada não existe "só o áudio do PC". */
const hasScreen = () => S.local.some((i) => i.kind === 'screen');
async function startSystemAudio() {
  if (machine.state !== 'IN_ROOM' || S.sysBusy || S.local.some((i) => i.kind === 'sysaudio') || !hasScreen()) return;
  S.sysBusy = true; render();
  const errors = [];
  try {
    const nativeItem = await tryNativeAudio();
    if (nativeItem) { if (!hasScreen()) { stopItem(nativeItem); return; } await addLocal(nativeItem); return; } // a tela parou enquanto o helper iniciava: descarta
    const native = !!vb.nativePicker;
    const id = native ? null : await audioSourceId();
    if (!id && !native) throw named('NoSource', 'nenhuma tela disponível para capturar o áudio');
    const env = await audioEnv();
    const plan = native ? (env.altDeviceId ? [['device', 0]] : []) : [...RETRY_DELAYS.map((d) => ['loopback', d]), ['legacy', 0], ...(env.altDeviceId ? [['device', 0]] : [])];
    if (!plan.length) throw named('AllAttemptsFailed', S.nativeError || 'o áudio por aplicativo não está disponível neste Windows');
    for (const [how, wait] of plan) {
      if (wait) await sleep(wait);
      try {
        const tracks = how === 'legacy' ? await grabLegacy(id) : how === 'device' ? await grabDevice(env.altDeviceId) : await grabLoopback(id);
        const stream = new MediaStream(tracks);
        const item = { sid: stream.id, label: 'Áudio do sistema', kind: 'sysaudio', audio: true, stream, cleanup: () => tracks.forEach((t) => t.stop()) };
        tracks.forEach((t) => t.addEventListener('ended', () => onLocalEnded(item)));
        if (!hasScreen()) { stopItem(item); return; } // a tela parou durante as tentativas: não transmite só o áudio
        await addLocal(item);
        if (errors.length) vb.log('info', 'System audio recovered', { how, previousErrors: errors });
        if (S.nativeFailed) say(`Áudio por aplicativo indisponível (${S.nativeError}). Transmitindo o áudio do sistema inteiro: a voz dos outros participantes pode voltar para eles (use fones).`, 'warn');
        return;
      } catch (e) { errors.push(`${how}: ${e.name}: ${e.message}`); vb.log('warn', 'System audio attempt failed', { how, name: e.name, error: e.message }); }
    }
    const first = (errors[0] || 'falhou').replace(/^\w+: /, '');
    const e = named('AllAttemptsFailed', first); e.env = env; throw e;
  } catch (e) {
    const env = e.env || (await audioEnv());
    vb.log('error', 'System audio failed', { errors, defaultOutput: env.defaultOutput, virtualOutput: env.virtual, alternative: !!env.altDeviceId });
    say(`Áudio do sistema indisponível (${e.message}). A tela continua sendo compartilhada normalmente.\n${audioAdvice(env)}`, 'warn');
  } finally { S.sysBusy = false; render(); }
}
// ---------- mixer: de quais aplicativos o som é transmitido ----------
const nativeItem = () => S.local.find((i) => i.native);
const appIncluded = (k) => { const a = appCfg(); return !a.blocked.includes(k) && (a.allowed.includes(k) || a.allowNew); };
function saveAppCfg() {
  S.cfg.appAudio = { ...appCfg() };
  vb.setConfig(S.cfg).then((c) => { S.cfg = c; }).catch(() => {});
  if (nativeItem()) vb.appAudioUpdate(appCfg()).catch(() => {}); // vale na hora, sem reiniciar a captura
}
function setAppIncluded(key, on) {
  const a = appCfg(), k = String(key).toLowerCase();
  if (on) { a.blocked = a.blocked.filter((x) => x !== k); if (!a.allowNew && !a.allowed.includes(k)) a.allowed.push(k); }
  else { a.allowed = a.allowed.filter((x) => x !== k); if (!a.blocked.includes(k)) a.blocked.push(k); }
  saveAppCfg(); renderMixer(true);
}
function setAllowNew(on) {
  const a = appCfg();
  if (!on) S.apps.forEach((x) => { if (appIncluded(x.key) && !a.allowed.includes(x.key)) a.allowed.push(x.key); }); // quem já está ligado continua ligado
  a.allowNew = on; saveAppCfg(); renderMixer(true);
}
async function refreshApps() {
  if (nativeItem()) return; // com a captura ativa, a lista chega por eventos do helper
  try { const r = await vb.appAudioList(appCfg()); S.apps = (r && r.apps) || []; S.appNote = ''; }
  catch (e) { S.apps = []; S.appNote = e.message; }
  renderMixer();
}
function renderMixer(force) {
  if ($('#mixer').classList.contains('hidden')) return;
  const rows = S.apps.map((a) => ({ ...a, included: appIncluded(a.key), present: true }));
  appCfg().blocked.filter((k) => !S.apps.some((a) => a.key === k)).forEach((k) => rows.push({ key: k, name: k, peak: 0, included: false, present: false }));
  const sig = rows.map((r) => `${r.key}|${r.included}|${r.present}|${r.name}`).join(';');
  if (force || sig !== S.mixerSig) {
    S.mixerSig = sig; S.meters.clear();
    const box = $('#mixerList'); box.textContent = '';
    if (!rows.length) box.append(el('div', { class: 'mut', text: 'Nenhum aplicativo está tocando áudio agora. Abra o que quiser transmitir: ele aparece aqui.' }));
    rows.forEach((r) => {
      const sw = el('input', { type: 'checkbox' }); sw.checked = r.included; sw.addEventListener('change', () => setAppIncluded(r.key, sw.checked));
      const meter = el('i'); S.meters.set(r.key, meter);
      box.append(el('div', { class: 'mixrow' + (r.included ? '' : ' off') + (r.present ? '' : ' gone') },
        el('div', { class: 'avatar', text: (r.name[0] || '?').toUpperCase() }),
        el('div', { class: 'mixname' }, el('b', { text: r.name }), el('span', { class: 'mut', text: r.key + (r.present ? '' : ' · fora de uso agora') + (S.appNotes[r.key] ? ' · ⚠ ' + S.appNotes[r.key] : '') })),
        el('div', { class: 'meter' }, meter), el('label', { class: 'switch', title: r.included ? 'Transmitindo o áudio deste aplicativo' : 'Áudio deste aplicativo NÃO é transmitido' }, sw, el('span'))));
    });
  }
  rows.forEach((r) => { const m = S.meters.get(r.key); if (m) m.style.width = Math.round(Math.sqrt(Math.min(1, r.peak || 0)) * 100) + '%'; });
  const st = S.appStatus;
  $('#mixerStatus').textContent = nativeItem() ? '● Transmitindo por aplicativo: as mudanças valem na hora.'
    : S.local.some((i) => i.kind === 'sysaudio') ? `Modo "sistema inteiro" (sem controle por aplicativo)${S.nativeError ? ': ' + S.nativeError : ''}.`
    : st && !st.supported ? `Indisponível neste PC: ${st.reason}`
    : appCfg().enabled === false ? 'Desativado em ⋮ Configurações → Áudio por aplicativo.'
    : S.appNote ? `Não foi possível listar os aplicativos: ${S.appNote}`
    : hasScreen() ? 'Ligue o botão de áudio (alto-falante) para transmitir o som junto com a sua tela. As escolhas já valem desde agora.'
    : 'O áudio do sistema só é transmitido junto com uma tela compartilhada. As escolhas já valem desde agora.';
}
function onAppEvent(ev) {
  if (!ev || typeof ev.event !== 'string') return;
  if (ev.event === 'apps' && Array.isArray(ev.apps)) {
    S.apps = ev.apps; S.appNotes = {}; ev.apps.forEach((a) => { if (a.error) S.appNotes[a.key] = a.error; }); renderMixer();
  } else if (ev.event === 'capture_error') { S.appNotes[String(ev.app)] = String(ev.message || 'falhou'); vb.log('warn', 'App capture failed', { app: ev.app, message: ev.message }); renderMixer(true); }
  else if (ev.event === 'exit') {
    const it = nativeItem();
    if (it) { say('O helper de áudio por aplicativo parou inesperadamente. Clique no botão de áudio (alto-falante) para ligar de novo.', 'err'); vb.log('error', 'Audio helper exited', { code: ev.code, error: ev.error }); removeLocal(it); }
  }
}
function toggleMixer() {
  const pop = $('#mixer'), open = pop.classList.contains('hidden');
  $('#quality').classList.add('hidden'); pop.classList.toggle('hidden', !open);
  clearInterval(S.mixerTimer); S.mixerTimer = null;
  if (!open) return;
  S.mixerSig = '';
  (async () => { if (!S.appStatus) { try { S.appStatus = await vb.appAudioStatus(); } catch (e) { S.appStatus = { supported: false, reason: e.message }; } } if (S.appStatus && S.appStatus.supported) await refreshApps(); renderMixer(true); })();
  S.mixerTimer = setInterval(() => { if (S.appStatus && S.appStatus.supported) refreshApps(); }, 1500);
}
const toggleSys = () => {
  const cur = S.local.find((i) => i.kind === 'sysaudio');
  if (cur) return removeLocal(cur);
  if (!hasScreen()) return say('O áudio do sistema só é transmitido junto com uma tela compartilhada. Compartilhe uma tela primeiro.', 'warn');
  return startSystemAudio();
};
async function testSystemAudio() {
  try {
    const id = await audioSourceId(); if (!id) return 'sem tela disponível';
    const env = await audioEnv(), how = [];
    const tries = [['loopback', () => grabLoopback(id)], ['API antiga', () => grabLegacy(id)], ...(env.altDeviceId ? [['dispositivo alternativo', () => grabDevice(env.altDeviceId)]] : [])];
    for (const [name, fn] of tries) {
      try { (await fn()).forEach((t) => t.stop()); how.push(`${name}: OK`); } catch (e) { how.push(`${name}: ${e.name}: ${e.message}`); }
    }
    const head = `saída padrão «${env.defaultOutput || 'desconhecida'}»${env.virtual ? ' (VIRTUAL: provável causa)' : ''}${env.altDeviceId ? ' · alternativa configurada/detectada' : ''}`;
    return head + '\n  ' + how.join(' | ');
  } catch (e) { return `${e.name}: ${e.message}`; }
}

async function toggleCamera() {
  if (machine.state !== 'IN_ROOM') return;
  const cur = S.local.find((i) => i.kind === 'camera');
  if (cur) return removeLocal(cur);
  try {
    const stream = await userMedia('video', S.cfg.webcam.deviceId);
    const item = { sid: stream.id, label: 'Câmera', kind: 'camera', audio: false, stream };
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => onLocalEnded(item)));
    await addLocal(item);
  } catch (e) { say(`Câmera indisponível (${e.name}: ${e.message}).`, 'err'); }
}
async function toggleMic() {
  if (machine.state !== 'IN_ROOM') return;
  if (!S.micItem) { // primeira vez: só agora pede permissão (item 36)
    try {
      const raw = await userMedia('audio', S.cfg.mic.deviceId);
      const ctx = new AudioContext(); await ctx.resume();
      const srcNode = ctx.createMediaStreamSource(raw), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
      gain.gain.value = S.cfg.mic.gain || 1; srcNode.connect(gain); gain.connect(dest);
      const item = { sid: dest.stream.id, label: 'Microfone', kind: 'mic', audio: true, stream: dest.stream, raw, cleanup: () => ctx.close() };
      S.micItem = item; S.micGainNode = gain; S.micMuted = false;
      await addLocal(item); sound('micOn');
    } catch (e) { say(`Microfone indisponível (${e.name}: ${e.message}).`, 'err'); }
  } else {
    S.micMuted = !S.micMuted;
    S.micGainNode.gain.value = S.micMuted ? 0 : S.cfg.mic.gain || 1;
    sound(S.micMuted ? 'micOff' : 'micOn');
  }
  broadcastStatus(); render();
}
function onLocalEnded(item) {
  if (!S.local.includes(item)) return;
  vb.log('warn', 'Source ended', { label: item.label });
  say(`A fonte "${item.label}" foi encerrada (janela fechada ou dispositivo desconectado).`, 'warn');
  removeLocal(item);
}
const isMuted = () => !S.micItem || S.micMuted;

// ---------- fontes locais <-> conexões (renegociação automática) ----------
function applyCodecPrefs(pc) {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;
  const ordered = V.orderCodecs(caps.codecs, S.cfg.codec);
  pc.getTransceivers().forEach((t) => { if (t.sender.track && t.sender.track.kind === 'video' && t.setCodecPreferences) { try { t.setCodecPreferences(ordered); } catch { /* mantém padrão */ } } });
}
function addItemTracks(p, item) {
  item.stream.getTracks().forEach((t) => { try { p.senders.set(t.id, p.pc.addTrack(t, item.stream)); } catch (e) { vb.log('warn', 'addTrack failed', { error: e.message }); } });
  applyCodecPrefs(p.pc);
}
const syncShareState = () => vb.setStreamState(S.local.some((i) => i.kind === 'screen' || i.kind === 'camera') ? 'STREAMING' : 'IDLE');
async function addLocal(item) {
  S.local.push(item);
  S.peers.forEach((p) => p.pc && addItemTracks(p, item)); // dispara negotiationneeded em cada conexão
  if (item.stream.getVideoTracks().length) addTile('local:' + item.sid, { local: true, role: item.kind, title: 'Você — ' + item.label, stream: item.stream, onStop: () => removeLocal(item) });
  if (item.kind === 'screen') sound('shareStart'); else if (item.kind === 'camera') sound('camOn');
  vb.log('info', 'Source added', { kind: item.kind, label: item.label });
  syncShareState(); syncDiscord(); render();
}
function stopItem(item) {
  item.stream.getTracks().forEach((t) => t.stop());
  if (item.raw) item.raw.getTracks().forEach((t) => t.stop());
  if (item.cleanup) { try { item.cleanup(); } catch { /* ignora */ } }
}
function removeLocal(item) {
  if (!S.local.includes(item)) return;
  S.local = S.local.filter((i) => i !== item);
  S.peers.forEach((p) => item.stream.getTracks().forEach((t) => {
    const s = p.senders.get(t.id);
    if (s) { try { p.pc.removeTrack(s); } catch { /* conexão fechando */ } p.senders.delete(t.id); }
  }));
  stopItem(item);
  if (item === S.micItem) { S.micItem = null; S.micGainNode = null; S.micMuted = false; broadcastStatus(); }
  removeTile('local:' + item.sid);
  if (item.kind === 'screen') sound('shareStop'); else if (item.kind === 'camera') sound('camOff');
  vb.log('info', 'Source removed', { kind: item.kind, label: item.label });
  syncShareState(); syncDiscord(); render();
  // parou a última tela: o áudio do sistema para junto (nunca fica só o áudio no ar)
  if (item.kind === 'screen' && !hasScreen()) { const sys = S.local.find((i) => i.kind === 'sysaudio'); if (sys) removeLocal(sys); }
}
const localMeta = () => S.local.map((i) => ({ sid: i.sid, label: i.label, kind: i.kind, audio: i.audio }));

// ---------- Discord (UM aviso por sala, do dono; mostra quem está compartilhando) ----------
/** O que eu estou compartilhando, em texto ("🖥 Jogo + 🔊"). */
function mySources() {
  const mine = S.local.filter((i) => i.kind === 'screen' || i.kind === 'camera'), hasSys = S.local.some((i) => i.kind === 'sysaudio');
  return mine.map((i, n) => `${icon(i.kind)}${i.label}${n === 0 && hasSys ? ' + 🔊' : ''}`);
}
/** Batimento: a cada 60 s (ou quando minhas fontes mudam) aviso o relay que continuo aqui. Quem vigia o aviso do Discord
 *  (o app do dono, depois que ele sai) usa isso para saber quem ainda está na sala e o que cada um compartilha. */
function startHeartbeat() {
  clearInterval(S.hbTimer); S.hbSig = ''; S.hbAt = Date.now();
  S.hbTimer = setInterval(() => {
    if (machine.state !== 'IN_ROOM') return;
    const src = mySources(), sig = JSON.stringify(src), now = Date.now();
    if (sig === S.hbSig && now - S.hbAt < 60000) return;
    S.hbSig = sig; S.hbAt = now; sigSend({ t: 'hb', name: S.name, src });
  }, 20000);
}
/** O aviso lista as fontes de TODOS na sala (as minhas e as que os outros anunciaram em `meta`). */
function discordMessage() {
  const sources = mySources().map((s) => `${S.name}: ${s}`);
  [...S.peers.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => {
    const sys = p.meta.some((x) => x.kind === 'sysaudio');
    p.meta.filter((x) => x.kind === 'screen' || x.kind === 'camera').forEach((x, n) => sources.push(`${p.name}: ${icon(x.kind)}${x.label}${n === 0 && sys ? ' + 🔊' : ''}`));
  });
  return { host: S.name, sources, people: S.peers.size + 1, invite: S.room.code, joinUrl: S.room.joinUrl };
}
function syncDiscord() {
  S.discordChain = S.discordChain.then(async () => {
    // Só o DONO anuncia: quem criou a sala (ou quem assumiu quando o dono saiu). O aviso dura até a sala esvaziar.
    if (!S.room || !S.dcOwner || !S.cfg.discord.announce) return;
    const m = discordMessage(), sig = JSON.stringify(m);
    if (S.discordOn && sig === S.discordLast) return; // nada mudou: não edita à toa
    if (!S.discordOn) { S.discordOn = !!(await vb.discordAnnounce(m)); if (S.discordOn) { S.discordLast = sig; say('Convite publicado no Discord.', 'mut'); } }
    else { await vb.discordUpdate(m); S.discordLast = sig; }
  }).catch((e) => say('Discord: ' + e.message, 'err'));
}
/** Rich Presence: o perfil do Discord oferece "Entrar" na sala (só muda quando pessoas/fontes mudam). */
function syncRich() {
  if (!S.room || !S.cfg.discord || S.cfg.discord.presence === false) return;
  const m = discordMessage(), sig = JSON.stringify([m.invite, m.people, m.sources]);
  if (sig === S.richLast) return;
  S.richLast = sig;
  vb.richUpdate({ code: m.invite, people: m.people, max: S.cfg.signaling.maxParticipants, sources: m.sources }).catch(() => {});
}
/** O dono vai sair mas a sala continua: quem tiver o MESMO webhook assume a mensagem (o 1º da fila, por ID). */
async function onDiscordHandoff(m) {
  if (S.dcOwner || !S.cfg.discord.announce || typeof m.webhookId !== 'string' || typeof m.messageId !== 'string') return;
  S.dcAdopted = false;
  const rank = Math.max(0, [S.myId, ...S.peers.keys()].filter((id) => id !== m.r).sort().indexOf(S.myId));
  await sleep(rank * 600);
  if (S.dcAdopted || machine.state !== 'IN_ROOM' || !S.room) return;
  const ok = await vb.discordAdopt({ webhookId: m.webhookId, messageId: m.messageId, started: Number(m.started) || 0, ...discordMessage() }).catch(() => false);
  if (!ok) return;
  S.dcOwner = true; S.discordOn = true; S.discordLast = '';
  sigSend({ t: 'dc_adopted' }); syncDiscord();
}

// ---------- participantes e conexões ----------
const sigSend = (m) => vb.sigSend(m).catch((e) => vb.log('warn', 'sigSend failed', { type: m && m.t, error: e.message }));
const sendHello = (to) => {
  S.helloSent = true;
  // Quem entra com um código precisa que alguém responda; senão a sala já acabou (ficou vazia) e o código não vale mais.
  if (!to && !S.created && !S.joinTimer) {
    S.joinTimer = setTimeout(() => {
      S.joinTimer = null;
      if (machine.state === 'IN_ROOM' && S.peers.size === 0) leaveRoom('Essa sala não existe mais: todos já saíram e ela foi encerrada. Crie uma nova sala.', { silent: true });
    }, JOIN_WAIT_MS);
  }
  const turn = S.cfg.shareTurn !== false ? V.sanitizeTurn(S.cfg.turn) : [];
  return sigSend({ t: 'hello', name: S.name, muted: isMuted(), ...(turn.length ? { turn } : {}), ...(to ? { to } : {}) });
};
const broadcastStatus = () => { if (machine.state === 'IN_ROOM' && S.helloSent) sigSend({ t: 'status', muted: isMuted() }); };

function ensurePeer(id, name) {
  let p = S.peers.get(id);
  if (p) { if (name) p.name = name; return p; }
  p = { id, name: name || 'Participante', polite: S.myId > id, making: false, queue: Promise.resolve(), pc: null, state: 'conectando…', meta: [], muted: true, senders: new Map(), quality: { height: S.cfg.resolution, fps: S.cfg.fps }, last: null, lossBad: 0, lossGood: 0, info: '' };
  S.peers.set(id, p);
  createPc(p); render();
  return p;
}
function createPc(p) {
  const pc = new RTCPeerConnection({ iceServers: iceServersFrom(S.cfg, S.sharedTurn), bundlePolicy: 'max-bundle' });
  p.pc = pc;
  pc.addEventListener('track', (e) => onTrack(p, e));
  pc.addEventListener('negotiationneeded', () => negotiate(p));
  pc.addEventListener('connectionstatechange', () => onPeerState(p));
  S.local.forEach((it) => addItemTracks(p, it));
  pc.addEventListener('datachannel', (e) => attachDc(p, e.channel));
  if (S.myId < p.id) { const dc = pc.createDataChannel('vb'); if (dc) attachDc(p, dc); } // o "iniciador" abre a conexão mesmo sem mídia; serve de sinal de vida e de canal de sinalização
}
/** Depois que o canal de dados abre, as renegociações (adicionar/remover tela) vão direto pelo P2P; o relay fica só para o primeiro contato. */
function attachDc(p, dc) {
  p.dc = dc;
  dc.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.length > 200000) return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (!m || m.t !== 'desc' || m.to !== S.myId) return; // pelo canal só passam descrições; o remetente é quem abriu o canal
    onSigMessage({ ...m, r: p.id });
  });
}
function sendDesc(p) {
  const msg = descMsg(p);
  if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(JSON.stringify(msg)); return Promise.resolve(); } catch { /* cai no relay */ } }
  return vb.sigSend(msg);
}
const descMsg = (p) => ({ t: 'desc', to: p.id, desc: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp }, meta: localMeta(), muted: isMuted() });

/**
 * Perfect negotiation: oferta implícita; ICE completo antes de enviar (sem trickle).
 * Tudo por par passa pela MESMA fila (p.queue), junto com as descrições recebidas: assim uma nova
 * oferta nunca começa no meio de uma resposta (isso trocava a resposta por uma oferta e travava os dois lados).
 */
function negotiate(p) {
  p.queue = p.queue.then(() => doNegotiate(p)).catch((e) => vb.log('error', 'Negotiation failed', { error: e.message }));
}
async function doNegotiate(p) {
  const pc = p.pc;
  if (!pc || pc.signalingState !== 'stable') return; // o navegador dispara "negotiationneeded" de novo quando voltar a estável
  try {
    p.making = true;
    await pc.setLocalDescription();
    await iceComplete(pc);
    if (pc.signalingState !== 'have-local-offer') return; // revertida por colisão
    await sendDesc(p);
  } finally { p.making = false; }
}
async function handleDesc(p, m) {
  const d = m.desc, pc = p.pc;
  if (!d || (d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string' || !d.sdp.startsWith('v=0') || !pc) return;
  const before = p.meta; p.meta = sanitizeMeta(m.meta); p.muted = !!m.muted; metaSounds(before, p.meta); applyMeta(p);
  const collision = d.type === 'offer' && (p.making || pc.signalingState !== 'stable');
  if (!p.polite && collision) return; // o "impolite" ignora a oferta concorrente; o outro lado desfaz a dele
  await pc.setRemoteDescription({ type: d.type, sdp: d.sdp }); // o "polite" faz rollback implícito
  if (d.type === 'offer') {
    await pc.setLocalDescription();
    await iceComplete(pc);
    await sendDesc(p);
  }
}
function metaSounds(before, after) {
  const had = new Set(before.map((x) => x.sid)), has = new Set(after.map((x) => x.sid));
  after.forEach((m) => { if (!had.has(m.sid)) { if (m.kind === 'screen') sound('shareStart'); else if (m.kind === 'camera') sound('camOn'); } });
  before.forEach((m) => { if (!has.has(m.sid)) { if (m.kind === 'screen') sound('shareStop'); else if (m.kind === 'camera') sound('camOff'); } });
}
const sanitizeMeta = (list) => (Array.isArray(list) ? list.filter((m) => m && typeof m.sid === 'string').slice(0, 16).map((m) => ({ sid: m.sid, label: String(m.label || 'Fonte').slice(0, 80), kind: String(m.kind || ''), audio: !!m.audio })) : []);
function applyMeta(p) {
  for (const [key, t] of [...S.tiles]) {
    if (t.ownerId !== p.id) continue;
    const m = p.meta.find((x) => x.sid === t.sid);
    if (!m) removeTile(key); else { t.setTitle(`${p.name} — ${m.label}`); if (m.kind) t.role = m.kind; }
  }
  S.tiles.forEach((t) => { if (t.ownerId === p.id) t.refreshAudioUi(); });
  applyOwnerAudio(p.id);
  render();
}
function onPeerState(p) {
  const st = p.pc.connectionState;
  vb.log('info', 'Peer state', { peer: p.id, state: st });
  if (st === 'connected') { p.state = 'conectado'; applyEncoding(p, p.quality); }
  else if (st === 'disconnected') p.state = 'conexão instável…';
  else if (st === 'failed') {
    const ex = V.explainFailure(p.pc.localDescription && p.pc.localDescription.sdp, p.pc.remoteDescription && p.pc.remoteDescription.sdp);
    vb.log('warn', 'P2P connection failed', { peer: p.id, local: ex.local, remote: ex.remote });
    say(`${p.name}: ${P2P_FAIL_MSG}\n${ex.summary}\n${ex.advice}\nPara tentar de novo, peça para essa pessoa sair e entrar na sala.`, 'err');
    removePeer(p); return;
  }
  else if (st === 'closed') { removePeer(p); return; }
  render();
}
function removePeer(p) {
  sound('peerLeave');
  try { p.pc.close(); } catch { /* ok */ }
  for (const [key, t] of [...S.tiles]) if (t.ownerId === p.id) removeTile(key);
  S.peers.delete(p.id); render();
}

function onSigMessage(m) {
  // saindo (esperando alguém assumir o aviso do Discord) ainda aceita a resposta `dc_adopted`
  if ((machine.state !== 'IN_ROOM' && !(machine.state === 'LEAVING' && m && m.t === 'dc_adopted')) || !m || typeof m.t !== 'string' || typeof m.r !== 'string' || !ID_RE.test(m.r) || m.r === S.myId) return;
  if (m.to && m.to !== S.myId) return;
  if (S.gone.has(m.r)) return; // quem já disse bye/closed não volta (IDs são únicos): ignora mensagens atrasadas que ainda estavam em trânsito
  try {
    if (m.t === 'hello') {
      const shared = V.sanitizeTurn(m.turn); if (shared.length) S.sharedTurn = shared; // o TURN de quem já está na sala vale para as próximas conexões
      const known = S.peers.has(m.r);
      const max = (S.cfg.signaling && S.cfg.signaling.maxParticipants) || 6;
      if (!known && S.peers.size >= max - 1) return void sigSend({ t: 'full', to: m.r, reason: `A sala está lotada (${max} participantes).` });
      const p = ensurePeer(m.r, String(m.name || 'Participante').slice(0, 40)); p.muted = !!m.muted;
      if (!known) sound('peerJoin');
      if (!known && !m.to) sendHello(m.r); // responde só a quem acabou de chegar (broadcast)
      render();
    } else if (m.t === 'status') { const p = S.peers.get(m.r); if (p) { p.muted = !!m.muted; render(); } }
    else if (m.t === 'bye') { S.gone.add(m.r); const p = S.peers.get(m.r); if (p) removePeer(p); }
    else if (m.t === 'dc_handoff') { onDiscordHandoff(m); }
    else if (m.t === 'dc_adopted') { S.dcAdopted = true; }
    else if (m.t === 'full') { leaveRoom(String(m.reason || 'A sala está lotada.'), { silent: true }); }
    else if (m.t === 'closed') { S.gone.add(m.r); const p = S.peers.get(m.r); if (p) removePeer(p); if (S.peers.size === 0) leaveRoom('A sala foi encerrada.', { silent: true }); }
    else if (m.t === 'desc') {
      const p = ensurePeer(m.r);
      p.queue = p.queue.then(() => handleDesc(p, m)).catch((e) => vb.log('error', 'Desc handling failed', { error: e.message }));
    }
  } catch (e) { vb.log('error', 'Signal handling failed', { type: m.t, error: e.message }); }
}

// ---------- volume por participante (microfone e áudio do sistema) ----------
const volOf = (id) => { let v = S.vol.get(id); if (!v) { v = { sys: 1, sysMuted: false, mic: 1, micMuted: false }; S.vol.set(id, v); } return v; };
function applyOwnerAudio(ownerId) {
  const v = volOf(ownerId);
  S.tiles.forEach((t) => {
    if (t.ownerId !== ownerId) return;
    if (t.role === 'sysaudio') { const owner = S.peers.get(ownerId), hasScr = !!owner && owner.meta.some((m) => m.kind === 'screen'); t.video.volume = v.sys; t.video.muted = S.deafened || v.sysMuted || !hasScr; } // sem tela, o áudio do sistema não toca (versões antigas / clientes diferentes)
    else if (t.role === 'mic') { t.video.volume = v.mic; t.video.muted = S.deafened || v.micMuted; }
    else t.video.muted = true; // vídeos (tela/câmera) não carregam áudio: o som vem das fontes dedicadas
  });
}
const applyAllAudio = () => new Set([...S.tiles.values()].map((t) => t.ownerId).filter(Boolean)).forEach(applyOwnerAudio);

// ---------- vídeo recebido ----------
function onTrack(p, e) {
  const stream = e.streams[0]; if (!stream) return;
  const key = `${p.id}:${stream.id}`;
  const meta = p.meta.find((x) => x.sid === stream.id);
  let tile = S.tiles.get(key);
  if (!tile) {
    const role = (meta && meta.kind) || (stream.getVideoTracks().length ? 'screen' : 'mic');
    tile = addTile(key, { ownerId: p.id, sid: stream.id, role, title: `${p.name} — ${meta ? meta.label : 'Fonte'}`, stream });
  }
  tile.refresh(); applyOwnerAudio(p.id);
  e.track.addEventListener('mute', () => tile.refresh()); e.track.addEventListener('unmute', () => tile.refresh());
  render();
}
function setFocus(key) {
  S.focusKey = key && S.tiles.has(key) && S.tiles.get(key).hasVideo ? key : null;
  renderStage();
}
function addTile(key, { local = false, ownerId = null, sid = null, role = 'screen', title, stream, onStop }) {
  const video = el('video', { autoplay: '', playsinline: '' });
  video.srcObject = stream;
  video.muted = local || role === 'screen' || role === 'camera'; // prévia local nunca toca áudio (evita eco)
  const wrap = el('div', { class: 'vwrap' }, video);
  const titleEl = el('b', { text: title });
  const bar = el('div', { class: 'bar' }, titleEl);
  const tile = { key, root: null, video, wrap, local, ownerId, sid, role, hasVideo: stream.getVideoTracks().length > 0, z: { ...V.ZOOM_RESET }, audioUi: null,
    setTitle: (t) => { titleEl.textContent = t; }, refresh: null, refreshAudioUi: () => {} };

  // volume/mudo da transmissão = áudio do sistema de quem compartilha (só aparece se essa pessoa estiver enviando áudio)
  if (!local && role === 'screen') {
    const muteIc = el('span', { class: 'ic i-volume' }), muteBtn = el('button', { title: 'Silenciar esta transmissão' }, muteIc);
    const vol = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', title: 'Volume da transmissão' });
    const syncUi = () => { const v = volOf(ownerId); muteIc.className = 'ic ' + (v.sysMuted || v.sys === 0 ? 'i-volume-off' : 'i-volume'); vol.value = String(v.sys); };
    muteBtn.addEventListener('click', () => { const v = volOf(ownerId); v.sysMuted = !v.sysMuted; applyOwnerAudio(ownerId); syncUi(); });
    vol.addEventListener('input', () => { const v = volOf(ownerId); v.sys = Number(vol.value); v.sysMuted = false; applyOwnerAudio(ownerId); syncUi(); });
    const group = el('span', { class: 'row' }, muteBtn, vol);
    tile.audioUi = group;
    tile.refreshAudioUi = () => { const p = S.peers.get(ownerId); group.classList.toggle('hidden', !(p && p.meta.some((m) => m.kind === 'sysaudio'))); syncUi(); };
    bar.append(group);
  }

  // zoom (roda do mouse / botões) e arrastar
  const zlbl = el('button', { class: 'zlbl', text: '100%', title: 'Voltar ao tamanho normal' });
  const dims = () => ({ w: wrap.clientWidth || 1, h: wrap.clientHeight || 1 });
  const applyZoom = () => {
    const z = tile.z; video.style.transformOrigin = '0 0';
    video.style.transform = z.s === 1 ? '' : `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
    zlbl.textContent = Math.round(z.s * 100) + '%'; wrap.classList.toggle('zoomed', z.s > 1);
  };
  const zoomAround = (cx, cy, f) => { const d = dims(); tile.z = V.zoomBy(tile.z, d.w, d.h, cx, cy, f); applyZoom(); };
  const zoomCenter = (f) => { const d = dims(); zoomAround(d.w / 2, d.h / 2, f); };
  wrap.addEventListener('wheel', (e) => { if (e.preventDefault) e.preventDefault(); const r = wrap.getBoundingClientRect(); zoomAround(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2); }, { passive: false });
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => { if (tile.z.s > 1) { drag = { x: e.clientX, y: e.clientY }; if (wrap.setPointerCapture) wrap.setPointerCapture(e.pointerId); } });
  wrap.addEventListener('pointermove', (e) => { if (!drag) return; const d = dims(); tile.z = V.panBy(tile.z, d.w, d.h, e.clientX - drag.x, e.clientY - drag.y); drag = { x: e.clientX, y: e.clientY }; applyZoom(); });
  const endDrag = () => { drag = null; };
  wrap.addEventListener('pointerup', endDrag); wrap.addEventListener('pointercancel', endDrag);
  zlbl.addEventListener('click', () => { tile.z = { ...V.ZOOM_RESET }; applyZoom(); });
  bar.append(el('button', { text: '−', title: 'Diminuir zoom', onclick: () => zoomCenter(1 / 1.25) }), zlbl, el('button', { text: '+', title: 'Aumentar zoom', onclick: () => zoomCenter(1.25) }));

  // foco e tela cheia (do cartão inteiro, para manter os controles)
  const focusBtn = el('button', { title: 'Destacar esta transmissão' }, el('span', { class: 'ic i-focus' }), 'Focar');
  focusBtn.addEventListener('click', () => setFocus(S.focusKey === key ? null : key));
  const toggleFs = () => {
    const root = tile.root;
    if (document.fullscreenElement && document.exitFullscreen) { document.exitFullscreen(); return; }
    const r = root.requestFullscreen && root.requestFullscreen();
    if (r && r.catch) r.catch(() => say('Não foi possível entrar em tela cheia.', 'warn'));
  };
  bar.append(focusBtn, el('button', { title: 'Tela cheia', onclick: toggleFs }, el('span', { class: 'ic i-maximize' })));
  if (local) bar.append(el('button', { class: 'stop', onclick: onStop }, el('span', { class: 'ic i-stop' }), 'Parar'));
  wrap.addEventListener('dblclick', toggleFs);

  const root = el('div', { class: 'tile' }, wrap, bar);
  tile.root = root; tile.focusBtn = focusBtn;
  root.addEventListener('click', () => { if (S.focusKey && S.focusKey !== key && tile.hasVideo) setFocus(key); }); // clicar numa miniatura foca nela
  tile.refresh = () => { tile.hasVideo = stream.getVideoTracks().length > 0; root.classList.toggle('hidden', !tile.hasVideo); renderStage(); };
  root.classList.toggle('hidden', !tile.hasVideo); // somente áudio (mic / áudio do sistema): toca, mas não ocupa o palco
  stream.addEventListener('addtrack', tile.refresh); stream.addEventListener('removetrack', tile.refresh);
  S.tiles.set(key, tile); $('#tiles').append(root);
  tile.refreshAudioUi(); if (ownerId) applyOwnerAudio(ownerId);
  renderStage();
  return tile;
}
function removeTile(key) {
  const t = S.tiles.get(key); if (!t) return;
  t.video.srcObject = null; t.root.remove(); S.tiles.delete(key);
  if (S.focusKey === key) S.focusKey = null;
  renderStage();
}
function renderStage() {
  const visible = [...S.tiles.values()].filter((t) => t.hasVideo);
  $('#emptyStage').classList.toggle('hidden', visible.length > 0);
  if (S.focusKey && !(S.tiles.get(S.focusKey) && S.tiles.get(S.focusKey).hasVideo)) S.focusKey = null;
  const focusing = !!S.focusKey && visible.length > 1;
  $('#tiles').classList.toggle('has-focus', focusing);
  S.tiles.forEach((t, k) => {
    t.root.classList.toggle('focused', focusing && k === S.focusKey);
    t.root.classList.toggle('thumb', focusing && k !== S.focusKey);
    if (t.focusBtn) t.focusBtn.textContent = S.focusKey === k ? 'Sair do foco' : 'Focar';
  });
}

// ---------- qualidade ----------
async function applyEncoding(p, q) {
  for (const sender of p.pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const item = S.local.find((i) => i.stream.getTracks().includes(sender.track));
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const capturedH = (sender.track.getSettings && sender.track.getSettings().height) || q.height;
    params.encodings[0].maxBitrate = kbpsFor(S.cfg, item && item.kind) * 1000;
    params.encodings[0].maxFramerate = q.fps;
    params.encodings[0].scaleResolutionDownBy = Math.max(1, capturedH / q.height);
    try { await sender.setParameters(params); } catch (e) { vb.log('warn', 'setParameters failed', { error: e.message }); }
  }
}
/** Aplica na hora (sem reiniciar a captura nem renegociar). */
async function applyQualityChange() {
  S.cfg = uiToCfg();
  const { w, h } = V.RESOLUTIONS[S.cfg.resolution];
  S.local.filter((i) => i.kind === 'screen').forEach((i) => i.stream.getVideoTracks().forEach((t) => {
    t.contentHint = hint();
    if (t.applyConstraints) t.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: S.cfg.fps } }).catch(() => {});
  }));
  S.peers.forEach((p) => { p.quality = { height: S.cfg.resolution, fps: S.cfg.fps }; applyEncoding(p, p.quality); });
  renderUplink();
  vb.setConfig(S.cfg).then((c) => { S.cfg = c; }).catch(() => {});
}
const PRESETS = { text: { res: 1080, fps: 30 }, balanced: { res: 1080, fps: 30 }, video: { res: 1080, fps: 60 } };
function markPreset() {
  [['text', '#presetText'], ['balanced', '#presetBalanced'], ['video', '#presetVideo']].forEach(([k, id]) => $(id).classList.toggle('sel', S.preset === k));
}
function applyPreset(name) {
  S.preset = name; $('#res').value = String(PRESETS[name].res); $('#fps').value = String(PRESETS[name].fps); markPreset(); applyQualityChange();
}
function renderUplink() {
  const cfg = S.cfg || uiToCfg(), n = Math.max(1, S.peers.size);
  const per = kbpsFor(cfg, 'screen');
  $('#uplink').textContent = `Upload estimado por tela: ~${(per / 1000).toFixed(1)} Mbps para cada participante (${n} agora ≈ ${(per * n / 1000).toFixed(1)} Mbps).`;
}
/** Degraus graduais: desce rápido sob perda sustentada, sobe devagar quando estável (item 24). */
function adapt(p, loss) {
  if (loss > 0.08) { p.lossBad++; p.lossGood = 0; } else if (loss < 0.01) { p.lossGood++; p.lossBad = 0; } else { p.lossBad = 0; }
  let next = null;
  if (p.lossBad >= 3) { next = V.stepDown(p.quality); p.lossBad = 0; }
  else if (p.lossGood >= 10 && (p.quality.height < S.cfg.resolution || p.quality.fps < S.cfg.fps)) { next = V.stepUp(p.quality); p.lossGood = 0; }
  if (next && (next.height !== p.quality.height || next.fps !== p.quality.fps)) {
    next = { height: Math.min(next.height, S.cfg.resolution), fps: Math.min(next.fps, S.cfg.fps) };
    p.quality = next; applyEncoding(p, next);
    vb.log('info', 'Adaptive quality', { peer: p.id, height: next.height, fps: next.fps });
  }
}
async function collectStats(p) {
  const stats = await p.pc.getStats(), now = performance.now();
  let out = 0, inn = 0, fps = 0, w = 0, h = 0, enc = '', codec = '', loss = 0;
  stats.forEach((r) => {
    if (r.type === 'outbound-rtp') {
      out += r.bytesSent || 0;
      if (r.kind === 'video' && (r.frameWidth || 0) >= w) { fps = r.framesPerSecond || fps; w = r.frameWidth || w; h = r.frameHeight || h; enc = r.encoderImplementation || enc; const c = stats.get(r.codecId); if (c) codec = c.mimeType.replace('video/', ''); }
    } else if (r.type === 'inbound-rtp') inn += r.bytesReceived || 0;
    else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') loss = Math.max(loss, r.fractionLost || 0);
  });
  const path = await selectedPath(p.pc), prev = p.last;
  const up = prev ? Math.round(((out - prev.out) * 8) / (now - prev.t)) : 0, down = prev ? Math.round(((inn - prev.inn) * 8) / (now - prev.t)) : 0;
  p.last = { out, inn, t: now };
  p.info = `${p.name}: ${path ? (path.local === 'relay' || path.remote === 'relay' ? 'relay' : 'P2P') : '?'}` + (path && path.rttMs != null ? ` · ${path.rttMs} ms` : '') + ` · ↑ ${(up / 1000).toFixed(1)} ↓ ${(down / 1000).toFixed(1)} Mbps` + (w ? ` · ${codec} ${w}x${h}@${Math.round(fps)}` : '') + ` · perda ${(loss * 100).toFixed(1)}%` + (enc ? ` · ${enc}` : '');
  p.enc = enc; p.codec = codec; p.path = path;
  adapt(p, loss);
}
function startStatsLoop() {
  startHeartbeat();
  clearInterval(S.statsTimer);
  S.statsTimer = setInterval(async () => {
    for (const p of S.peers.values()) { if (p.pc.connectionState === 'connected') { try { await collectStats(p); } catch { /* fechando */ } } }
    renderStatus();
  }, 2000);
}

// ---------- sala: entrar / sair ----------
const CLOSED_MSG = 'Essa sala já foi encerrada (todos saíram) e o código não vale mais. Crie uma nova sala.';
async function joinRoom(codeText) {
  if (machine.state !== 'LOBBY') return;
  const name = $('#lobbyName').value.trim() || ('Participante ' + randId().slice(0, 3).toUpperCase());
  $('#myName').value = name; S.name = name;
  machine.to('JOINING'); lobbySay('Conectando…', 'mut');
  try {
    S.cfg = await vb.setConfig({ ...uiToCfg(), hostName: name });
    S.myId = randId(); S.helloSent = false; S.sigState = ''; S.created = !codeText; S.dcOwner = !codeText; S.discordLast = ''; S.richLast = ''; S.dcAdopted = false; S.lastAlone = null;
    S.room = await vb.sigOpen(codeText || null, S.myId);
    machine.to('IN_ROOM'); lobbySay('', 'mut');
    if (S.sigState === 'closed') { await leaveRoom(CLOSED_MSG, { silent: true }); return; } // o código é de uma sala já encerrada
    sound('enter');
    startStatsLoop(); renderUplink();
    if (S.sigState === 'live') sendHello();
    if (!codeText) { await vb.copy(S.room.joinUrl || S.room.code); say('Sala criada. O ' + (S.room.joinUrl ? 'link' : 'código') + ' foi copiado — envie aos seus amigos.', 'mut'); syncDiscord(); syncRich(); }
    else say('Entrando na sala…', 'mut');
    setTimeout(() => { if (machine.state === 'IN_ROOM' && !S.helloSent) say('Relay de signaling indisponível: ninguém conseguirá se conectar. Verifique a internet ou troque o relay em ⋮ Configurações.', 'err'); }, 12000);
    vb.log('info', 'Joined room', { created: !codeText });
  } catch (e) {
    lobbySay(e.message, 'err'); vb.log('error', 'Join failed', { error: e.message });
    await vb.sigClose().catch(() => {}); machine.to('LOBBY');
  }
}
/** silent: não anuncia saída (nunca chegou a entrar de fato) nem toca o som de saída. */
async function leaveRoom(reason, opts = {}) {
  if (machine.state !== 'IN_ROOM') return;
  machine.to('LEAVING'); clearInterval(S.statsTimer); clearInterval(S.hbTimer); clearTimeout(S.joinTimer); S.joinTimer = null;
  if (!opts.silent && S.dcOwner && S.discordOn && S.peers.size > 0) {
    // Sou o dono do convite e a sala continua: tento passar a mensagem a quem tiver o mesmo webhook (até 2,5 s).
    S.dcAdopted = false;
    const info = await vb.discordHandoffInfo().catch(() => null);
    if (info) {
      try { await vb.sigSend({ t: 'dc_handoff', ...info }); } catch { /* relay fora do ar */ }
      for (let i = 0; i < 25 && !S.dcAdopted; i++) await sleep(100);
      if (S.dcAdopted) { await vb.discordRelease().catch(() => {}); S.discordOn = false; }
    }
  }
  if (!opts.silent) {
    // O último a sair ENCERRA a sala (`closed`): o código deixa de funcionar para quem tentar entrar depois.
    const alone = S.peers.size === 0;
    try { await vb.sigSend({ t: alone ? 'closed' : 'bye' }); } catch { /* relay fora do ar */ }
    sound('leave');
  }
  await vb.sigClose().catch(() => {});
  S.peers.forEach((p) => { try { p.pc.close(); } catch { /* ok */ } }); S.peers.clear();
  [...S.local].forEach(stopItem); S.local = []; S.micItem = null; S.micGainNode = null; S.micMuted = false;
  [...S.tiles.keys()].forEach(removeTile);
  await vb.discordEnd().catch(() => {}); S.discordOn = false; S.dcOwner = false; S.discordLast = ''; S.richLast = ''; vb.richClear().catch(() => {});
  S.room = null; S.helloSent = false; S.focusKey = null; S.lastAlone = null; S.gone.clear(); S.sharedTurn = []; syncShareState(); say('', 'mut');
  machine.to('LOBBY'); if (reason) lobbySay(reason, 'warn');
  vb.log('info', 'Left room; engine released');
}

// ---------- seletor de fontes ----------
/** WebView2: o seletor de tela é o do próprio navegador (o app não escolhe a fonte por id como no Electron). */
async function startNativeShare() {
  const { w, h } = V.RESOLUTIONS[S.cfg.resolution];
  let stream;
  try { stream = await getScreen(w, h, S.cfg.fps, false); }
  catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') return; // fechou o seletor
    vb.log('error', 'Screen capture failed', { name: e.name, error: e.message });
    return say(`Não foi possível capturar a tela: ${e.message}`, 'err');
  }
  const track = stream.getVideoTracks()[0], label = (track && track.label) || 'Tela';
  const item = { sid: stream.id, label, kind: 'screen', audio: false, stream };
  stream.getVideoTracks().forEach((t) => { t.contentHint = hint(); t.addEventListener('ended', () => onLocalEnded(item)); });
  await addLocal(item);
  if (S.cfg.systemAudio) await startSystemAudio();
}
async function openPicker() {
  if (machine.state !== 'IN_ROOM') return;
  if (vb.nativePicker) return startNativeShare();
  S.pickerSel = new Set(); $('#pickerAudio').checked = S.cfg.systemAudio;
  const box = $('#pickerList'); box.textContent = '';
  try { S.pickerSources = await vb.listSources(); } catch (e) { return say('Não foi possível listar as fontes: ' + e.message, 'err'); }
  // Duas seções, para diferenciar de cara tela inteira de janela
  [['screen', '🖥', 'Telas inteiras', 'Nenhuma tela encontrada.', 'Tela inteira'], ['window', '🪟', 'Janelas', 'Nenhuma janela aberta.', 'Janela']].forEach(([kind, icon, title, empty, label]) => {
    const items = S.pickerSources.filter((s) => s.kind === kind), grid = el('div', { class: 'sources' });
    items.forEach((s) => {
      const card = el('div', { class: 'src', onclick: () => { if (S.pickerSel.has(s.id)) S.pickerSel.delete(s.id); else S.pickerSel.add(s.id); card.classList.toggle('sel'); } },
        el('img', { src: s.thumb || '', alt: '' }), el('span', { text: s.name }), el('span', { class: 'mut kind', text: icon + ' ' + label }));
      grid.append(card);
    });
    box.append(el('section', { class: 'srcgroup' }, el('h3', { text: `${icon} ${title} (${items.length})` }), items.length ? grid : el('div', { class: 'mut', text: empty })));
  });
  $('#picker').classList.remove('hidden');
}
async function confirmPicker() {
  const ids = [...S.pickerSel]; $('#picker').classList.add('hidden');
  if (!ids.length) return;
  S.cfg = uiToCfg(); S.cfg.systemAudio = $('#pickerAudio').checked;
  say('', 'mut');
  await startShares(ids, S.cfg.systemAudio);
}

// ---------- configurações e diagnóstico ----------
let settingsSnap = '';
const settingsOpen = () => !$('#settings').classList.contains('hidden');
/** "Foto" do formulário: se mudou desde que abriu, há alterações não salvas. */
const snapSettings = () => { try { return JSON.stringify(uiToCfg()) + '|' + $('#turnLines').value; } catch { return ''; } };
async function openSettings() {
  cfgToUi(S.cfg); await refreshDevices().catch(() => {}); $('#settingsMsg').textContent = '';
  settingsSnap = snapSettings(); $('#settings').classList.remove('hidden');
}
/** Pergunta (na própria página) o que fazer com as alterações: 'save' | 'discard' | 'keep'. */
function askUnsaved() {
  return new Promise((resolve) => {
    const dlg = $('#confirmDlg');
    const done = (v) => { dlg.classList.add('hidden'); S.confirmResolve = null; resolve(v); };
    S.confirmResolve = done;
    dlg.classList.remove('hidden');
  });
}
async function saveSettings() {
  try {
    const tv = V.parseTurnLines($('#turnLines').value); await saveCfg(); S.name = S.cfg.hostName || S.name; $('#lobbyName').value = S.cfg.hostName;
    $('#settingsMsg').textContent = tv.errors.length ? 'Salvo, mas ignorei linhas do TURN: ' + tv.errors.join(' ') : 'Configurações salvas.';
    if (machine.state === 'IN_ROOM' && S.helloSent) sendHello(); renderUplink(); settingsSnap = snapSettings(); return true;
  } catch (e) { $('#settingsMsg').textContent = 'Falha ao salvar: ' + e.message; return false; }
}
/** Fechar (botão, clique fora ou Esc): se houver alterações não salvas, pergunta antes. */
async function requestCloseSettings() {
  if (!settingsOpen() || S.confirmResolve) return;
  if (snapSettings() !== settingsSnap) {
    const choice = await askUnsaved();
    if (choice === 'keep') return;
    if (choice === 'save' && !(await saveSettings())) return; // não salvou: fica aberto mostrando o motivo
  }
  $('#settings').classList.add('hidden');
}
/** Clique no fundo escuro (só se o clique COMEÇOU e terminou nele: arrastar uma seleção de texto para fora não fecha). */
function onBackdrop(el, fn) {
  let down = false;
  el.addEventListener('pointerdown', (e) => { down = !!e && e.target === el; });
  el.addEventListener('click', (e) => { const ok = down && !!e && e.target === el; down = false; if (ok) fn(); });
}
async function runDiag() {
  const out = $('#diag'); out.textContent = 'Executando…';
  const L = [];
  const caps = RTCRtpSender.getCapabilities('video');
  const codecs = [...new Set((caps ? caps.codecs : []).map((c) => c.mimeType.replace('video/', '')))].filter((c) => !/rtx|red|ulpfec|flexfec/i.test(c));
  L.push(`WebRTC: ${typeof RTCPeerConnection === 'function' ? 'OK' : 'indisponível'}`, `Codecs de vídeo (envio): ${codecs.join(', ') || '?'}`, `CPU lógicas: ${navigator.hardwareConcurrency}`);
  const cands = []; const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] });
  pc.createDataChannel('d'); pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate); };
  await pc.setLocalDescription(await pc.createOffer()); await iceComplete(pc, 5000); pc.close();
  const srflx = cands.filter((c) => c.type === 'srflx'), v6 = cands.some((c) => (c.address || '').includes(':'));
  const v4m = srflx.filter((c) => !(c.address || '').includes(':')), ports = new Set(v4m.map((c) => c.port));
  L.push(`STUN: ${srflx.length ? 'OK (endereço público obtido)' : 'sem resposta (firewall/rede bloqueando UDP?)'}`, `IPv6: ${v6 ? 'Disponível' : 'Não detectado'}`,
    `NAT: ${!v4m.length ? 'indeterminado' : ports.size > 1 ? 'NAT simétrico (provável) — P2P tende a falhar sem IPv6' : 'mapeamento estável (P2P provável)'}`);
  const rt = await vb.sigSelfTest().catch((e) => ({ ok: false, error: e.message }));
  L.push('Relay de signaling: ' + (rt ? (rt.ok ? `OK (${rt.ms} ms) — ${rt.relay}` : `FALHOU — ${rt.error} (${rt.relay}). Sem relay as pessoas não conseguem se encontrar.`) : '?'));
  const peer = [...S.peers.values()].find((p) => p.pc.connectionState === 'connected');
  if (peer) L.push(`P2P: ${peer.path ? 'OK ' + peer.path.local + '/' + peer.path.remote + (peer.path.ipv6 ? ' (IPv6)' : '') : '?'}`, `Codec ativo: ${peer.codec || '?'}`, `Encoder: ${peer.enc || '?'}${/MediaFoundation|ExternalEncoder|VideoToolbox|NVENC/i.test(peer.enc || '') ? ' (hardware)' : /OpenH264|libvpx|libaom|SimulcastEncoder/i.test(peer.enc || '') ? ' (software)' : ''}`, `Latência (RTT): ${peer.path && peer.path.rttMs != null ? peer.path.rttMs + ' ms' : '?'}`);
  else L.push('P2P/Encoder: entre numa sala com alguém conectado e compartilhe algo para incluir estes itens.');
  L.push('Captura: Windows Graphics Capture (via Chromium)');
  const ast = await vb.appAudioStatus().catch((e) => ({ supported: false, reason: e.message }));
  L.push('Áudio por aplicativo: ' + (ast && ast.supported ? `OK (Windows ${ast.os})` : `indisponível: ${(ast && ast.reason) || '?'}`));
  if (ast && ast.supported) {
    const t = await vb.appAudioTest().catch((e) => ({ ok: false, error: e.message }));
    S.perAppOk = !!(t && t.ok);
    L.push('  teste de captura por processo: ' + (!t ? '?' : t.ok ? `OK (${t.app}; formato ${t.format || '?'}; amostras ${t.samples}, pico ${t.peak})` : t.none ? '(abra um aplicativo com áudio para testar)' : `FALHOU (${t.app || '?'}): ${t.error}`));
    if (t && !t.ok && Array.isArray(t.probe)) { L.push('  tentativas (formato / flags → resultado do Windows):'); t.probe.forEach((p) => L.push('    ' + p)); }
  }
  const perAppOk = ast && ast.supported && !!S.perAppOk;
  L.push('Áudio do sistema pelo Chromium (modo alternativo' + (perAppOk ? '; não é necessário, o modo por aplicativo está funcionando' : '') + '): ' + (await testSystemAudio()));
  out.textContent = L.join('\n');
}

// ---------- renderização ----------
function render() {
  syncDiscord(); syncRich();
  const st = machine.state, inRoom = st === 'IN_ROOM' || st === 'LEAVING';
  $('#lobby').classList.toggle('hidden', inRoom); $('#roomView').classList.toggle('hidden', !inRoom);
  $('#btnCreate').disabled = st !== 'LOBBY'; $('#btnJoin').disabled = st !== 'LOBBY';
  if (!inRoom) return;
  $('#roomChip').textContent = S.room ? S.room.code.slice(0, 9) + '…' : '';
  $('#relayDot').className = 'dot ' + (S.sigState === 'live' || S.sigState === 'online' ? 'on' : S.sigState === 'offline' ? 'off' : '');
  $('#btnMic').classList.toggle('off', isMuted()); $('#btnMic').title = !S.micItem ? 'Ativar microfone' : S.micMuted ? 'Desmutar' : 'Mutar';
  $('#btnDeaf').classList.toggle('off', S.deafened);
  const screens = S.local.filter((i) => i.kind === 'screen').length;
  $('#screenCount').textContent = screens ? `+ ${screens}` : '';
  $('#btnCam').classList.toggle('active', S.local.some((i) => i.kind === 'camera'));
  $('#btnSys').classList.toggle('active', S.local.some((i) => i.kind === 'sysaudio')); $('#btnSys').disabled = S.sysBusy || !hasScreen();
  $('#btnSys').title = hasScreen() ? 'Áudio do sistema (transmitido junto com a sua tela)' : 'Compartilhe uma tela para transmitir o áudio do sistema';
  $('#btnMixer').classList.toggle('active', !!nativeItem());
  $('#btnScreen').classList.toggle('active', screens > 0);
  $('#peopleCount').textContent = String(S.peers.size + 1);
  const box = $('#participants'); box.textContent = '';
  const row = (name, you, muted, kinds, state, peer) => {
    const kids = [el('div', { class: 'avatar', text: (name[0] || '?').toUpperCase() }), el('span', { class: 'name', text: name + (you ? ' (você)' : '') + (state ? ` · ${state}` : '') })];
    if (peer) { // volume do microfone dessa pessoa (só para mim)
      const v = volOf(peer.id), sl = el('input', { type: 'range', class: 'pvol', min: '0', max: '1', step: '0.05', title: `Volume do microfone de ${name}` });
      sl.value = String(v.mic); sl.addEventListener('input', () => { v.mic = Number(sl.value); v.micMuted = false; applyOwnerAudio(peer.id); });
      kids.push(sl);
    }
    const icos = [kinds.includes('screen') && 'monitor', kinds.includes('camera') && 'camera', kinds.includes('sysaudio') && 'volume', muted ? 'mic-off' : 'mic'].filter(Boolean);
    kids.push(el('span', { class: 'ico' }, ...icos.map((n) => el('span', { class: 'ic i-' + n }))));
    return el('div', { class: 'person' }, ...kids);
  };
  box.append(row(S.name, true, isMuted(), S.local.map((i) => i.kind), ''));
  [...S.peers.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => box.append(row(p.name, false, p.muted, p.meta.map((m) => m.kind), p.state === 'conectado' ? '' : p.state, p)));
  const alone = S.peers.size === 0; // informa o processo principal: se a janela fechar sozinha na sala, a sala é encerrada
  if (alone !== S.lastAlone) { S.lastAlone = alone; vb.setAlone(alone); }
  renderStage(); renderStatus();
}
function renderStatus() {
  const lines = [...S.peers.values()].filter((p) => p.info).map((p) => p.info);
  $('#statusbar').textContent = lines.join('\n');
  $('#statusbar').classList.toggle('hidden', !lines.length);
}

// ---------- eventos ----------
const closePopover = () => { $('#quality').classList.add('hidden'); if (!$('#mixer').classList.contains('hidden')) toggleMixer(); };
$('#btnCreate').addEventListener('click', () => joinRoom(null));
$('#btnJoin').addEventListener('click', () => { const c = $('#codeIn').value.trim(); if (!c) return lobbySay('Cole o código ou o link da sala.', 'warn'); joinRoom(c); });
$('#codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
$('#lobbyName').addEventListener('input', () => { $('#myName').value = $('#lobbyName').value; });
$('#btnLobbySettings').addEventListener('click', () => openSettings());
$('#btnSettings').addEventListener('click', () => openSettings());
$('#btnCloseSettings').addEventListener('click', () => requestCloseSettings());
onBackdrop($('#settings'), () => requestCloseSettings());
onBackdrop($('#picker'), () => $('#picker').classList.add('hidden'));
onBackdrop($('#confirmDlg'), () => S.confirmResolve && S.confirmResolve('keep'));
$('#cfmSave').addEventListener('click', () => S.confirmResolve && S.confirmResolve('save'));
$('#cfmDiscard').addEventListener('click', () => S.confirmResolve && S.confirmResolve('discard'));
$('#cfmKeep').addEventListener('click', () => S.confirmResolve && S.confirmResolve('keep'));
if (typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', (e) => {
    if (!e || e.key !== 'Escape') return;
    if (S.confirmResolve) S.confirmResolve('keep');
    else if (settingsOpen()) requestCloseSettings();
    else if (!$('#picker').classList.contains('hidden')) $('#picker').classList.add('hidden');
  });
}
$('#btnSave').addEventListener('click', () => saveSettings());
$('#btnDiag').addEventListener('click', () => runDiag().catch((e) => { $('#diag').textContent = 'Falha: ' + e.message; }));
$('#btnMic').addEventListener('click', () => toggleMic());
$('#btnDeaf').addEventListener('click', () => { S.deafened = !S.deafened; applyAllAudio(); sound(S.deafened ? 'deafOn' : 'deafOff', true); render(); });
$('#btnSys').addEventListener('click', () => toggleSys());
$('#btnMixer').addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); toggleMixer(); });
$('#mixer').addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
$('#mixNew').addEventListener('change', () => setAllowNew($('#mixNew').checked));
vb.onAppAudioEvent(onAppEvent);
$('#btnSfxTest').addEventListener('click', () => { S.cfg.sfx = { enabled: true, volume: Number($('#sfxVol').value) }; sound('enter', true); S.cfg.sfx.enabled = $('#sfxOn').checked; });
$('#btnGear').addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (!$('#mixer').classList.contains('hidden')) toggleMixer(); $('#quality').classList.toggle('hidden'); renderUplink(); });
$('#quality').addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
document.addEventListener('click', closePopover);
$('#btnScreen').addEventListener('click', () => openPicker());
$('#btnScreen2').addEventListener('click', () => openPicker());
$('#btnCam').addEventListener('click', () => toggleCamera());
$('#btnCam2').addEventListener('click', () => toggleCamera());
$('#btnLeave').addEventListener('click', () => leaveRoom());
$('#btnShareRoom').addEventListener('click', async () => { if (S.room) { await vb.copy(S.room.joinUrl || S.room.code); say('Link/código da sala copiado.', 'mut'); } });
$('#pickerCancel').addEventListener('click', () => $('#picker').classList.add('hidden'));
$('#pickerGo').addEventListener('click', () => confirmPicker());
$('#presetText').addEventListener('click', () => applyPreset('text'));
$('#presetBalanced').addEventListener('click', () => applyPreset('balanced'));
$('#presetVideo').addEventListener('click', () => applyPreset('video'));
$('#bitrate').addEventListener('change', () => { $('#bitrateCustom').classList.toggle('hidden', $('#bitrate').value !== 'custom'); applyQualityChange(); });
['#res', '#fps', '#codec', '#bitrateCustom'].forEach((s) => $(s).addEventListener('change', () => applyQualityChange()));
$('#micGain').addEventListener('input', () => { S.cfg.mic.gain = Number($('#micGain').value); if (S.micGainNode && !S.micMuted) S.micGainNode.gain.value = S.cfg.mic.gain; });
vb.onSigMessage(onSigMessage);
vb.onSigStatus((st) => {
  S.sigState = st && st.state;
  if (S.sigState === 'closed' && machine.state === 'IN_ROOM') { leaveRoom(CLOSED_MSG, { silent: true }); return; }
  if (S.sigState === 'live' && machine.state === 'IN_ROOM' && !S.helloSent) sendHello();
  render();
});
vb.onInvite((code) => {
  if (machine.state === 'LOBBY') { $('#codeIn').value = code; joinRoom(code); }
  else say('Saia da sala atual antes de entrar em outra.', 'warn');
});
vb.onUpdate((u) => say(`Nova versão ${u.tag} disponível — clique com o botão direito no ícone da bandeja e escolha "Nova versão… baixar".`, 'mut'));
vb.onHotkey((name) => {
  if (name === 'toggleStream') { const s = S.local.filter((i) => i.kind === 'screen'); if (s.length) s.forEach(removeLocal); else openPicker(); }
  else if (name === 'stopShare') S.local.filter((i) => i.kind !== 'mic').forEach(removeLocal);
  else if (name === 'toggleCamera') toggleCamera();
  else if (name === 'toggleMic') toggleMic();
});
window.addEventListener('beforeunload', () => { S.local.forEach(stopItem); S.peers.forEach((p) => { try { p.pc.close(); } catch { /* ok */ } }); });

(async () => {
  S.cfg = await vb.getConfig(); cfgToUi(S.cfg); S.name = S.cfg.hostName || '';
  vb.version().then((v) => { if (v) $('#ver').textContent = 'v' + v; }).catch(() => {});
  render(); renderUplink();
  await refreshDevices().catch(() => {});
})();
})();

// Tela cheia: a barra do cartão vira overlay que aparece ao mexer o mouse e some sozinha.
(() => {
  if (typeof document.addEventListener !== 'function') return;
  let timer = null;
  const full = () => document.fullscreenElement;
  document.addEventListener('mousemove', () => {
    const f = full(); if (!f || !f.classList) return;
    f.classList.add('uiactive'); clearTimeout(timer);
    timer = setTimeout(() => { const g = full(); if (g && g.classList) g.classList.remove('uiactive'); }, 2500);
  });
  document.addEventListener('fullscreenchange', () => {
    clearTimeout(timer);
    if (typeof document.querySelectorAll === 'function') document.querySelectorAll('.tile.uiactive').forEach((t) => t.classList.remove('uiactive'));
  });
})();
