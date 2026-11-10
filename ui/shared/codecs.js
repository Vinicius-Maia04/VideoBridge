'use strict';
/** Abstração de codec (item 20): ordena capabilities para setCodecPreferences. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VB = Object.assign(root.VB || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  const AUX = /(rtx|red|ulpfec|flexfec)/i;

  /**
   * Coloca o codec preferido primeiro (ex.: 'H264'), seguido dos demais
   * (fallback automático na negociação). Dentro de H.264 prefere
   * packetization-mode=1 e perfil baseline/constrained (melhor compatibilidade).
   * Codecs auxiliares (rtx/red/fec) ficam por último.
   */
  function orderCodecs(codecs, preferred) {
    const want = 'VIDEO/' + String(preferred || 'H264').toUpperCase();
    const score = (c) => {
      const mt = c.mimeType.toUpperCase();
      if (AUX.test(mt)) return 100;
      let s = mt === want ? 0 : mt === 'VIDEO/H264' ? 10 : mt === 'VIDEO/VP9' ? 20 : mt === 'VIDEO/VP8' ? 30 : 40;
      if (mt === 'VIDEO/H264') {
        const f = c.sdpFmtpLine || '';
        if (!/packetization-mode=1/.test(f)) s += 2;
        if (!/profile-level-id=42/.test(f)) s += 1;
      }
      return s;
    };
    return codecs.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.c);
  }
  return { orderCodecs };
});
