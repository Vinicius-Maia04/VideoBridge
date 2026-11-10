/**
 * Executa o room.js REAL em um contexto isolado imitando o Electron:
 * `vb` não configurável (como o contextBridge), DOM simulado e WebRTC simulado.
 * Os FakePC "enxergam" as tracks uns dos outros pelo conteúdo do SDP, o que permite
 * testar a negociação simétrica de ponta a ponta sem navegador.
 */
const vm = require('vm'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..', 'ui');

class FakeEl {
  constructor(id) {
    this.id = id; this.value = ''; this.checked = false; this.className = ''; this.disabled = false; this._text = '';
    this.listeners = {}; this.children = []; this.srcObject = null; this.muted = false; this.parent = null; this.volume = 1;
    this.style = { transform: '' }; this.clientWidth = 800; this.clientHeight = 450;
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, f) => { (f === undefined ? !set.has(c) : f) ? set.add(c) : set.delete(c); } };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; this.children = []; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  append(...k) { k.forEach((c) => { if (c && typeof c === 'object') c.parent = this; this.children.push(c); }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  click() { (this.listeners.click || []).forEach((f) => f({ stopPropagation() {} })); }
  fire(t, ev = {}) { (this.listeners[t] || []).forEach((f) => f(ev)); }
}
const named = (name, msg) => Object.assign(new Error(msg), { name });
const unref = (fn) => (...a) => { const h = fn(...a); if (h && h.unref) h.unref(); return h; };
let uid = 0;
/** Relógio dos testes: por padrão é o real; clock.freeze() o congela e clock.advance(ms) o move (testes sem depender de tempo real). */
function makeClock() { const c = { frozen: false, t: 0, now() { return c.frozen ? c.t : Date.now(); }, freeze() { c.frozen = true; c.t = Date.now(); return c; }, advance(ms) { c.t += ms; return c; } }; return c; }
function makeTrack(kind) { return { kind, id: 'trk' + ++uid, enabled: true, listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, stop() { this.stopped = true; }, getSettings: () => ({ height: 1080 }) }; }
function makeStream(id, { audio = false, video = true, tracks } = {}) {
  const t = tracks || [...(video ? [makeTrack('video')] : []), ...(audio ? [makeTrack('audio')] : [])];
  return { id, getTracks: () => t, getVideoTracks: () => t.filter((x) => x.kind === 'video'), getAudioTracks: () => t.filter((x) => x.kind === 'audio'), addEventListener() {}, _tracks: t };
}

function boot({ vbOverrides = {}, cfg, media = {}, padSdp = 0, joinWaitMs = 600000 } = {}) {
  const els = new Map(), calls = [], handlers = {}, pcs = [], gdm = [], audioCtxs = [], worklets = [], clock = makeClock();
  class FakeDate extends Date { static now() { return clock.now(); } }
  const html = fs.readFileSync(path.join(R, 'room.html'), 'utf8');
  const $ = (sel) => {
    if (!els.has(sel)) {
      const e = new FakeEl(sel); els.set(sel, e);
      const m = sel.startsWith('#') && new RegExp('<[^>]*\\bid="' + sel.slice(1) + '"[^>]*>').exec(html); // classes iniciais declaradas no HTML
      const c = m && /class="([^"]*)"/.exec(m[0]); if (c) c[1].split(/\s+/).filter(Boolean).forEach((k) => e.classList.add(k));
    }
    return els.get(sel);
  };
  const config = cfg || { hostName: 'Eu', resolution: 1080, fps: 30, bitrate: 'auto', codec: 'H264', priority: 'balanced', systemAudio: true,
    mic: { enabled: false, deviceId: '', gain: 1 }, webcam: { enabled: false, deviceId: '' }, stun: [], signaling: { relay: 'https://ntfy.sh', maxParticipants: 6 },
    discord: { announce: false, webhookUrl: '', joinPageUrl: '' }, sfx: { enabled: true, volume: 0.5 }, hotkeys: {}, autostart: false, startMinimized: false };
  const vbApi = new Proxy({}, { get: (_t, name) => {
    if (name === 'nativePicker') return vbOverrides.nativePicker; // propriedade, não função (WebView2 = true)
    if (vbOverrides[name]) return (...a) => { calls.push([name, ...a]); return vbOverrides[name](...a); };
    if (name.startsWith('on')) return (fn) => { handlers[name] = fn; return () => {}; };
    return (...a) => {
      calls.push([name, ...a]);
      if (name === 'getConfig') return Promise.resolve(config);
      if (name === 'setConfig') return Promise.resolve(a[0]);
      if (name === 'listSources') return Promise.resolve([{ id: 'screen:1', name: 'Tela 1', kind: 'screen', thumb: '' }, { id: 'window:2', name: 'Jogo', kind: 'window', thumb: '' }]);
      if (name === 'sigOpen') return Promise.resolve({ code: 'VB2.AAAAAAAAAAAAAAAAAAAAAA', joinUrl: '' });
      return Promise.resolve(null);
    };
  } });
  class FakePC {
    constructor(cfg) { pcs.push(this); this.cfg = cfg; this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.signalingState = 'stable'; this.localDescription = null; this.l = {}; this.senders = []; this.seen = new Set(); this.rstreams = new Map(); this.negQueued = false; }
    get remoteDescription() { return this.remote || null; }
    addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); } removeEventListener() {}
    fire(t, ev) { (this.l[t] || []).forEach((f) => f(ev)); }
    need() { if (this.signalingState !== 'stable') { this.dirty = true; return; } if (this.negQueued) return; this.negQueued = true; Promise.resolve().then(() => { this.negQueued = false; if (this.signalingState === 'stable') this.fire('negotiationneeded'); }); }
    addTrack(track, stream) { const s = { track, stream, getParameters: () => ({ encodings: [] }), setParameters: async function (p) { this.params = p; } }; this.senders.push(s); this.need(); return s; }
    removeTrack(s) { this.senders = this.senders.filter((x) => x !== s); this.need(); }
    createDataChannel() { this.hasDc = true; this.need(); }
    getTransceivers() { return []; } getSenders() { return this.senders; }
    async setLocalDescription(d) {
      if (!d) d = { type: this.signalingState === 'have-remote-offer' ? 'answer' : 'offer' };
      const payload = Buffer.from(JSON.stringify({ tracks: this.senders.map((s) => ({ sid: s.stream.id, id: s.track.id, kind: s.track.kind })) })).toString('base64');
      this.localDescription = { type: d.type, sdp: 'v=0\r\na=vbfake:' + payload + '\r\n' + (padSdp ? 'a=pad:' + 'x'.repeat(padSdp) + '\r\n' : '') };
      this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
      this.settle();
    }
    settle() { if (this.signalingState === 'stable' && this.dirty) { this.dirty = false; this.need(); } }
    async createOffer() { return { type: 'offer' }; } async createAnswer() { return { type: 'answer' }; }
    async setRemoteDescription(d) {
      this.remote = d;
      this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; // oferta recebida em have-local-offer = rollback implícito
      this.settle();
      const m = /a=vbfake:([^\r\n]+)/.exec(d.sdp); if (!m) return;
      const info = JSON.parse(Buffer.from(m[1], 'base64').toString());
      for (const t of info.tracks) {
        if (this.seen.has(t.id)) continue; this.seen.add(t.id);
        let st = this.rstreams.get(t.sid); if (!st) { st = makeStream(t.sid, { tracks: [] }); this.rstreams.set(t.sid, st); }
        const track = makeTrack(t.kind); track.id = t.id; st._tracks.push(track);
        this.fire('track', { streams: [st], track });
      }
    }
    setState(s) { this.connectionState = s; this.fire('connectionstatechange'); }
    close() { this.closed = true; this.signalingState = 'closed'; } async getStats() { return new Map(); }
  }
  let n = 0;
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, performance: { now: () => Date.now() },
    Date: FakeDate, Promise, JSON, Math, Set, Map, Object, Number, String, Array, Error, Uint8Array, crypto: require('crypto').webcrypto,
    document: { querySelector: $, createElement: (t) => new FakeEl(t), addEventListener(t, f) { (this.l = this.l || {})[t] = f; } },
    navigator: { hardwareConcurrency: 8, mediaDevices: {
      enumerateDevices: async () => media.devices || [], addEventListener() {},
      getDisplayMedia: async (c) => {
        gdm.push(c);
        if (c.audio) { media.audioCalls = (media.audioCalls || 0) + 1; if (media.audioFails || media.audioCalls <= (media.audioFailTimes || 0)) throw named('NotReadableError', 'Could not start audio source'); }
        return makeStream('scr' + ++n + '_' + uid, { audio: !!c.audio });
      },
      getUserMedia: async (c) => {
        if (c.audio && c.audio.deviceId && c.audio.deviceId.exact && (media.sysDeviceIds || []).includes(c.audio.deviceId.exact)) { (media.deviceRequests = media.deviceRequests || []).push(c); return makeStream('dev' + ++n + '_' + uid, { audio: true, video: false }); }
        if (c.audio && c.audio.mandatory) { if (!media.legacyOk) throw named('NotSupportedError', 'legacy desktop audio'); return makeStream('leg' + ++n + '_' + uid, { audio: true, video: true }); }
        if (media.micFails && c.audio) throw named('NotReadableError', 'Could not start audio source');
        return makeStream('um' + ++n + '_' + uid, { audio: !!c.audio, video: !!c.video });
      } } },
    AudioWorkletNode: class { constructor(c, name, o) { worklets.push(this); this.ctx = c; this.name = name; this.opts = o; this.posted = []; this.port = { postMessage: (m) => this.posted.push(m) }; } connect() {} },
    MediaStream: class { constructor(tracks) { this._tracks = [...tracks]; this.id = 'ms' + ++uid; } getTracks() { return this._tracks; } getVideoTracks() { return this._tracks.filter((x) => x.kind === 'video'); } getAudioTracks() { return this._tracks.filter((x) => x.kind === 'audio'); } addEventListener() {} },
    RTCRtpSender: { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) }, RTCPeerConnection: FakePC,
    AudioContext: class {
      constructor(opts) { audioCtxs.push(this); this.opts = opts; this.freqs = []; this.modules = []; this.currentTime = 0; this.destination = {}; this.state = 'running'; this.audioWorklet = { addModule: async (url) => { if (media.workletFails) throw new Error('addModule falhou'); this.modules.push(url); } }; }
      async resume() {} async close() { this.closed = true; }
      createMediaStreamSource() { return { connect() {} }; }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
      createOscillator() { const ctx = this; return { type: '', frequency: { setValueAtTime(f) { ctx.freqs.push(f); } }, connect() {}, start() {}, stop() {} }; }
      createMediaStreamDestination() { return { stream: makeStream('mix' + ++n + '_' + uid, { audio: true, video: false }) }; }
    },
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx; ctx.self = ctx; ctx.addEventListener = () => {};
  ctx.VB_RETRY_DELAYS = [0, 1, 1]; ctx.VB_JOIN_WAIT_MS = joinWaitMs; // atalhos de teste (em produção: 0/500/1500 ms e 8 s)
  Object.defineProperty(ctx, 'vb', { value: vbApi, configurable: false, writable: false, enumerable: true }); // = contextBridge
  for (const m of html.matchAll(/<script src="([^"]+)"/g)) vm.runInContext(fs.readFileSync(path.join(R, m[1]), 'utf8'), ctx, { filename: m[1] });
  const tick = async (k = 1) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };
  const sent = (type) => calls.filter((c) => c[0] === 'sigSend' && c[1].t === type).map((c) => c[1]);
  const sounds = () => {
    const { SOUNDS } = ctx.VB; const out = [];
    for (const c of audioCtxs) { for (let i = 0; i < c.freqs.length;) { const name = Object.keys(SOUNDS).find((k) => SOUNDS[k].notes[0].f === c.freqs[i]); if (!name) { i++; continue; } out.push(name); i += SOUNDS[name].notes.length; } }
    return out;
  };
  const myId = () => { const c = calls.find((x) => x[0] === 'sigOpen'); return c && c[2]; };
  const msg = (m) => handlers.onSigMessage(m);
  const status = (state) => handlers.onSigStatus({ state });
  /** cria uma sala (ou entra) e deixa o relay "live". */
  async function enter({ code = null, name = 'Eu' } = {}) {
    await tick(2); $('#lobbyName').value = name;
    if (code) { $('#codeIn').value = code; $('#btnJoin').click(); } else $('#btnCreate').click();
    await tick(6); status('live'); await tick(4);
  }
  /** abre o seletor, escolhe a 1ª fonte e confirma. */
  async function shareFirstSource({ audio = true } = {}) {
    $('#btnScreen').click(); await tick(4);
    const cards = (e) => e.children.flatMap((c) => (c && c.className === 'src' ? [c] : c && c.children ? cards(c) : []));
    $('#pickerAudio').checked = audio; cards($('#pickerList'))[0].click(); $('#pickerGo').click(); await tick(18);
    await new Promise((r) => setTimeout(r, 25)); // as tentativas do áudio do sistema são espaçadas em tempo real (1 ms nos testes)
    await tick(6);
  }
  return { $, calls, config, tick, handlers, pcs, gdm, sent, myId, msg, status, enter, shareFirstSource, makeStream, sounds, ctx, media, worklets, audioCtxs, clock };
}
module.exports = { boot, FakeEl, makeStream, makeTrack };
