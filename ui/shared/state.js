'use strict';
/** Máquinas de estado (item 54). UMD: usado no Node (testes) e no renderer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VB = Object.assign(root.VB || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  const HOST_STATES = {
    IDLE: ['PREPARING'],
    PREPARING: ['CAPTURING', 'STOPPING'],
    CAPTURING: ['CONNECTING', 'STOPPING'],
    CONNECTING: ['STREAMING', 'CAPTURING', 'STOPPING'],
    STREAMING: ['CONNECTING', 'CAPTURING', 'STOPPING'],
    STOPPING: ['IDLE'],
  };
  const VIEWER_STATES = {
    VIEWER_IDLE: ['CONNECTING'],
    CONNECTING: ['CONNECTED', 'DISCONNECTED'],
    CONNECTED: ['WATCHING', 'DISCONNECTED'],
    WATCHING: ['DISCONNECTED'],
    DISCONNECTED: ['VIEWER_IDLE', 'CONNECTING'],
  };

  /** Estados da sala única (cada participante pode compartilhar e assistir). */
  const ROOM_STATES = {
    LOBBY: ['JOINING'],
    JOINING: ['IN_ROOM', 'LOBBY'],
    IN_ROOM: ['LEAVING'],
    LEAVING: ['LOBBY'],
  };

  function createMachine(table, initial, onChange) {
    let state = initial;
    return {
      get state() { return state; },
      can(next) { return (table[state] || []).includes(next); },
      to(next) {
        if (!this.can(next)) throw new Error(`Transição inválida: ${state} -> ${next}`);
        const prev = state;
        state = next;
        if (onChange) onChange(prev, next);
        return state;
      },
    };
  }
  return { HOST_STATES, VIEWER_STATES, ROOM_STATES, createMachine };
});
