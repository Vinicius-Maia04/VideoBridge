const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../ui/shared/quality');
const { orderCodecs } = require('../ui/shared/codecs');

test('bitrate automático é monotônico e respeita limites', () => {
  const a = Q.autoBitrateKbps(720, 30, 'H264'), b = Q.autoBitrateKbps(1080, 30, 'H264'), c = Q.autoBitrateKbps(1080, 60, 'H264');
  assert.ok(a < b && b < c);
  assert.ok(Q.autoBitrateKbps(360, 15, 'H264') >= 300);
  assert.ok(Q.autoBitrateKbps(1440, 60, 'H264') <= 20000);
  assert.ok(Q.autoBitrateKbps(1080, 60, 'AV1') < Q.autoBitrateKbps(1080, 60, 'H264'));
  assert.throws(() => Q.autoBitrateKbps(999, 30, 'H264'));
});
test('uplink: mesh multiplica por espectador', () => {
  assert.equal(Q.requiredUplinkMbps(6000, 5), 30);
  const few = Q.feasibleOptions(20, 1, 'H264'), many = Q.feasibleOptions(20, 5, 'H264');
  assert.ok(few.length > many.length);
  assert.ok(few.some((o) => o.height === 1080 && o.fps === 60));
  assert.ok(!many.some((o) => o.height === 1080 && o.fps === 60));
});
test('escada de adaptação desce e sobe gradualmente', () => {
  assert.deepEqual(Q.stepDown({ height: 1080, fps: 60 }), { height: 1080, fps: 30 });
  assert.deepEqual(Q.stepDown(Q.stepDown({ height: 1080, fps: 60 })), { height: 720, fps: 30 });
  assert.deepEqual(Q.stepDown({ height: 480, fps: 30 }), { height: 480, fps: 30 });
  assert.deepEqual(Q.stepUp({ height: 720, fps: 30 }), { height: 1080, fps: 30 });
  assert.deepEqual(Q.stepUp({ height: 1080, fps: 60 }), { height: 1080, fps: 60 });
});
test('codecs: preferido primeiro, H264 compatível antes, auxiliares no fim', () => {
  const caps = [
    { mimeType: 'video/VP8' }, { mimeType: 'video/rtx' },
    { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=0;profile-level-id=640c1f' },
    { mimeType: 'video/AV1' },
    { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/VP9' },
  ];
  const o = orderCodecs(caps, 'H264').map((c) => c.mimeType + '|' + (c.sdpFmtpLine || ''));
  assert.match(o[0], /packetization-mode=1;profile-level-id=42e01f/);
  assert.equal(o[o.length - 1], 'video/rtx|');
  assert.equal(orderCodecs(caps, 'AV1')[0].mimeType, 'video/AV1');
  assert.equal(orderCodecs(caps, 'VP9')[0].mimeType, 'video/VP9');
  assert.equal(orderCodecs(caps, 'H264').length, caps.length);
});
