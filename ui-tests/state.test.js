const test = require('node:test');
const assert = require('node:assert/strict');
const { HOST_STATES, VIEWER_STATES, createMachine } = require('../ui/shared/state');

test('host: fluxo completo e eventos', () => {
  const seen = [];
  const m = createMachine(HOST_STATES, 'IDLE', (a, b) => seen.push(`${a}>${b}`));
  ['PREPARING', 'CAPTURING', 'CONNECTING', 'STREAMING', 'STOPPING', 'IDLE'].forEach((s) => m.to(s));
  assert.equal(m.state, 'IDLE');
  assert.equal(seen.length, 6);
});
test('host: transições inválidas lançam erro e não mudam o estado', () => {
  const m = createMachine(HOST_STATES, 'IDLE');
  assert.throws(() => m.to('STREAMING'), /inválida/);
  assert.equal(m.state, 'IDLE');
});
test('host: pode voltar de STREAMING a CONNECTING/CAPTURING e abortar em PREPARING', () => {
  const m = createMachine(HOST_STATES, 'IDLE');
  m.to('PREPARING'); m.to('STOPPING'); m.to('IDLE');
  m.to('PREPARING'); m.to('CAPTURING'); m.to('CONNECTING'); m.to('STREAMING'); m.to('CONNECTING'); m.to('CAPTURING');
});
test('espectador: fluxo e reconexão', () => {
  const m = createMachine(VIEWER_STATES, 'VIEWER_IDLE');
  ['CONNECTING', 'CONNECTED', 'WATCHING', 'DISCONNECTED', 'CONNECTING'].forEach((s) => m.to(s));
  assert.ok(!m.can('WATCHING'));
});
