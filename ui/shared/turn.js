'use strict';
/** Servidores TURN opcionais (relay para quando o P2P direto não é possível). Sem TURN nada muda: o P2P direto continua sendo o padrão. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VB = Object.assign(root.VB || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX = 5;
  const URL_RE = /^turns?:[^\s|]{1,250}$/i;
  const okStr = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\0-\x1f]/.test(v);

  /** Valida uma lista (da configuração ou recebida de outro participante). */
  function sanitizeTurn(list) {
    const out = [];
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || typeof s !== 'object' || typeof s.urls !== 'string' || !URL_RE.test(s.urls.trim()) || !okStr(s.username, 200) || !okStr(s.credential, 300)) continue;
      out.push({ urls: s.urls.trim(), username: s.username, credential: s.credential });
      if (out.length >= MAX) break;
    }
    return out;
  }
  /** Texto do usuário: uma linha por servidor, "url|usuário|senha". Linhas com # são comentários. */
  function parseTurnLines(text) {
    const servers = [], errors = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim(); if (!line || line.startsWith('#')) return;
      const [url = '', user = '', cred = ''] = line.split('|').map((x) => x.trim());
      if (!URL_RE.test(url)) return errors.push(`Linha ${i + 1}: URL inválida (use turn:servidor:3478 ou turns:servidor:5349).`);
      if (!okStr(user, 200) || !okStr(cred, 300)) return errors.push(`Linha ${i + 1}: informe usuário e senha (url|usuário|senha).`);
      if (servers.length >= MAX) return errors.push(`No máximo ${MAX} servidores TURN.`);
      servers.push({ urls: url, username: user, credential: cred });
    });
    return { servers, errors };
  }
  const formatTurnLines = (servers) => sanitizeTurn(servers).map((s) => `${s.urls}|${s.username}|${s.credential}`).join('\n');
  return { sanitizeTurn, parseTurnLines, formatTurnLines };
});
