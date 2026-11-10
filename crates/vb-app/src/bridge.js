// Ponte entre a interface (sem acesso ao sistema) e o processo Rust. Mesma API que o antigo preload.js do Electron.
(() => {
  'use strict';
  const pending = new Map();
  const listeners = Object.create(null);
  let seq = 0;
  const post = (o) => window.ipc.postMessage(JSON.stringify(o));
  const invoke = (ch, ...args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); post({ id, ch, args }); });
  const send = (ch, ...args) => post({ ch, args });
  const on = (ch, fn) => {
    (listeners[ch] = listeners[ch] || []).push(fn);
    return () => { listeners[ch] = (listeners[ch] || []).filter((f) => f !== fn); };
  };
  const emit = (ch, payload) => (listeners[ch] || []).slice().forEach((f) => { try { f(payload); } catch (e) { console.error(e); } });
  const b64 = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

  Object.defineProperty(window, '__vb', {
    value: Object.freeze({
      resolve(id, ok, value) { const p = pending.get(id); if (!p) return; pending.delete(id); if (ok) p.resolve(value); else p.reject(new Error(String(value))); },
      emit,
      pcm(s) { emit('appaudio:pcm', b64(s)); },
    }),
  });

  window.vb = Object.freeze({
    // O seletor de tela é o do próprio WebView2 (o Electron deixava o app escolher a fonte por id).
    nativePicker: true,
    listSources: (thumbs = true) => invoke('sources:list', thumbs),
    selectSource: (id, audio) => invoke('capture:select', id, !!audio),
    getConfig: () => invoke('config:get'),
    setConfig: (c) => invoke('config:set', c),
    discordAnnounce: (m) => invoke('discord:announce', m),
    discordUpdate: (m) => invoke('discord:update', m),
    discordEnd: () => invoke('discord:end'),
    discordHandoffInfo: () => invoke('discord:handoffInfo'),
    discordAdopt: (m) => invoke('discord:adopt', m),
    discordRelease: () => invoke('discord:release'),
    copy: (t) => invoke('clipboard:write', t),
    sigOpen: (code, peerId) => invoke('sig:open', code, peerId),
    sigSend: (m) => invoke('sig:send', m),
    sigClose: () => invoke('sig:close'),
    sigSelfTest: () => invoke('sig:selfTest'),
    appAudioStatus: () => invoke('appaudio:status'),
    appAudioList: (cfg) => invoke('appaudio:list', cfg),
    appAudioStart: (cfg) => invoke('appaudio:start', cfg),
    appAudioUpdate: (cfg) => invoke('appaudio:update', cfg),
    appAudioStop: () => invoke('appaudio:stop'),
    appAudioTest: () => invoke('appaudio:test'),
    onAppAudioPcm: (fn) => on('appaudio:pcm', fn),
    onAppAudioEvent: (fn) => on('appaudio:event', fn),
    onSigMessage: (fn) => on('sig:message', fn),
    onSigStatus: (fn) => on('sig:status', fn),
    setStreamState: (s) => send('stream:state', s),
    setAlone: (b) => send('room:alone', !!b),
    log: (level, msg, extra) => send('log', level, msg, extra),
    version: () => invoke('app:version'),
    onHotkey: (fn) => on('hotkey', fn),
    onInvite: (fn) => on('room:invite', fn),
    onUpdate: (fn) => on('update:available', fn),
  });
})();
