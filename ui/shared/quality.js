'use strict';
/** Resolução, FPS, bitrate automático e escada de adaptação (itens 21-24). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VB = Object.assign(root.VB || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  const RESOLUTIONS = {
    360: { w: 640, h: 360 }, 480: { w: 854, h: 480 }, 720: { w: 1280, h: 720 },
    1080: { w: 1920, h: 1080 }, 1440: { w: 2560, h: 1440 },
  };
  const FPS_OPTIONS = [15, 30, 60];
  const BITS_PER_PIXEL = { H264: 0.07, VP8: 0.08, VP9: 0.05, AV1: 0.04 };

  /** Bitrate automático em kbps a partir de resolução, fps e codec. */
  function autoBitrateKbps(height, fps, codec) {
    const r = RESOLUTIONS[height];
    if (!r) throw new Error('Resolução inválida: ' + height);
    const bpp = BITS_PER_PIXEL[codec] || BITS_PER_PIXEL.H264;
    const kbps = Math.round((r.w * r.h * fps * bpp) / 1000);
    return Math.max(300, Math.min(kbps, 20000));
  }

  /** Mesh P2P: o host envia um fluxo por espectador. */
  function requiredUplinkMbps(kbpsPerViewer, viewers) {
    return (kbpsPerViewer * Math.max(1, viewers)) / 1000;
  }

  /** Opções de resolução/fps que cabem no uplink informado (com 20% de folga). */
  function feasibleOptions(uplinkMbps, viewers, codec) {
    const out = [];
    for (const h of Object.keys(RESOLUTIONS).map(Number)) {
      for (const fps of FPS_OPTIONS) {
        const need = requiredUplinkMbps(autoBitrateKbps(h, fps, codec), viewers) * 1.2;
        if (need <= uplinkMbps) out.push({ height: h, fps });
      }
    }
    return out;
  }

  const LADDER = [
    { height: 1080, fps: 60 }, { height: 1080, fps: 30 },
    { height: 720, fps: 30 }, { height: 480, fps: 30 },
  ];
  /** Degrau da escada mais próximo (sem exceder resolução e fps pedidos). */
  const stepIndex = (c) => {
    const i = LADDER.findIndex((s) => s.height <= c.height && s.fps <= c.fps);
    return i === -1 ? LADDER.length - 1 : i;
  };
  const stepDown = (c) => LADDER[Math.min(stepIndex(c) + 1, LADDER.length - 1)];
  const stepUp = (c) => LADDER[Math.max(stepIndex(c) - 1, 0)];

  return { RESOLUTIONS, FPS_OPTIONS, autoBitrateKbps, requiredUplinkMbps, feasibleOptions, stepDown, stepUp, LADDER };
});
