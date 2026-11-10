'use strict';
/** Utilitários do renderer. Dados de convites são não confiáveis: só textContent/atributos, nunca HTML bruto. */
window.$ = (s, r = document) => r.querySelector(s);
window.el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  kids.flat().forEach((c) => e.append(c));
  return e;
};
/**
 * Espera a coleta de candidatos ICE (sem trickle: o relay tem limite de taxa, então a descrição sai completa).
 * Termina quando a coleta acaba, ou `graceMs` depois do primeiro candidato público (srflx/relay) — antes o app
 * esperava o timeout inteiro (6 s) sempre que um dos 4 servidores STUN estava lento ou bloqueado.
 */
window.iceComplete = (pc, timeoutMs = 6000, graceMs = 700) => new Promise((resolve) => {
  if (pc.iceGatheringState === 'complete') return resolve();
  let grace = null;
  const done = () => { pc.removeEventListener('icegatheringstatechange', onChange); pc.removeEventListener('icecandidate', onCand); clearTimeout(t); clearTimeout(grace); resolve(); };
  const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
  const onCand = (e) => { if (!grace && e.candidate && / typ (srflx|relay) /.test(e.candidate.candidate || '')) grace = setTimeout(done, graceMs); };
  const t = setTimeout(done, timeoutMs);
  pc.addEventListener('icegatheringstatechange', onChange);
  pc.addEventListener('icecandidate', onCand);
});
/** STUN + TURN próprios + TURN compartilhado pela sala (sem repetir). */
window.iceServersFrom = (cfg, shared) => {
  const out = [];
  if (cfg.stun && cfg.stun.length) out.push({ urls: cfg.stun });
  const seen = new Set();
  [...(cfg.turn || []), ...(shared || [])].forEach((s) => { const k = s.urls + '|' + s.username; if (!seen.has(k)) { seen.add(k); out.push({ urls: s.urls, username: s.username, credential: s.credential }); } });
  return out;
};
window.P2P_FAIL_MSG = 'Não foi possível estabelecer uma conexão P2P direta.';

/** Resumo do par de candidatos ICE selecionado (P2P direto, IPv6, relay). */
window.selectedPath = async (pc) => {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
  if (!pair) return null;
  const l = stats.get(pair.localCandidateId) || {}, r = stats.get(pair.remoteCandidateId) || {};
  return { local: l.candidateType, remote: r.candidateType, ipv6: String(l.address || l.ip || '').includes(':'), rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null };
};
