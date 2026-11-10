'use strict';
/** Matemática de zoom/arrasto do vídeo assistido (funções puras). Origem da transformação = canto superior esquerdo. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VB = Object.assign(root.VB || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN = 1, MAX = 8, EPS = 1e-6;
  const RESET = Object.freeze({ s: 1, tx: 0, ty: 0 });

  /** Mantém o conteúdo coberto: nunca mostra borda vazia ao dar zoom/arrastar. */
  function clampPan(s, w, h, tx, ty) {
    return { tx: Math.min(0, Math.max(w * (1 - s), tx)), ty: Math.min(0, Math.max(h * (1 - s), ty)) };
  }
  /** Zoom para a escala `ns` mantendo fixo o ponto (cx, cy) sob o cursor. */
  function zoomTo(st, w, h, cx, cy, ns) {
    const s = Math.min(MAX, Math.max(MIN, ns));
    if (s <= MIN + EPS) return { ...RESET }; // evita resíduo de ponto flutuante (ex.: 1.0000000000000002) preso em "zoom"
    const tx = cx - (cx - st.tx) * (s / st.s), ty = cy - (cy - st.ty) * (s / st.s);
    return { s, ...clampPan(s, w, h, tx, ty) };
  }
  const zoomBy = (st, w, h, cx, cy, factor) => zoomTo(st, w, h, cx, cy, st.s * factor);
  function panBy(st, w, h, dx, dy) {
    if (st.s <= MIN) return { ...RESET };
    return { s: st.s, ...clampPan(st.s, w, h, st.tx + dx, st.ty + dy) };
  }
  return { zoomTo, zoomBy, panBy, clampPan, ZOOM_RESET: RESET, ZOOM_MIN: MIN, ZOOM_MAX: MAX };
});
