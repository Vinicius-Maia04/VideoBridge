'use strict';
/**
 * Análise de candidatos ICE a partir do SDP dos dois lados, para explicar POR QUE uma conexão P2P falhou
 * (o que o app mostra ao usuário em vez de um genérico "verifique firewall/NAT").
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VB = Object.assign(root.VB || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  /** Conta candidatos por tipo (host/srflx/prflx/relay) e detecta IPv6 global. */
  function parseCandidates(sdp) {
    const c = { host: 0, srflx: 0, prflx: 0, relay: 0, ipv6: false, total: 0 };
    for (const m of String(sdp || '').matchAll(/^a=candidate:\S+ \d+ \w+ \d+ (\S+) \d+ typ (\w+)/gm)) {
      const addr = m[1].toLowerCase(), type = m[2];
      if (!(type in c)) continue;
      c[type]++; c.total++;
      if (addr.includes(':') && !/^(fe80|fc|fd)/.test(addr)) c.ipv6 = true; // IPv6 global (não link-local nem ULA)
    }
    return c;
  }
  const reachable = (c) => c.srflx > 0 || c.relay > 0 || c.ipv6;
  function describe(c) {
    if (!c.total) return 'nenhuma informação de rede';
    const parts = [];
    if (c.srflx) parts.push('endereço público (STUN)');
    if (c.ipv6) parts.push('IPv6');
    if (c.relay) parts.push('relay (TURN)');
    if (!parts.length) parts.push('só endereço da rede local (sem endereço público)');
    return parts.join(' + ');
  }
  /** { local, remote, summary, advice } em português, a partir do SDP local e do remoto da conexão que falhou. */
  function explainFailure(localSdp, remoteSdp) {
    const L = parseCandidates(localSdp), R = parseCandidates(remoteSdp);
    const summary = `Sua rede: ${describe(L)}. Rede do outro participante: ${describe(R)}.`;
    let advice;
    if (!R.total) advice = 'Não chegou nenhuma informação de rede do outro participante: a negociação pode ter sido interrompida. Peça para ele sair e entrar de novo na sala.';
    else if (!reachable(R)) advice = 'O outro participante não conseguiu descobrir o próprio endereço público: UDP/STUN está bloqueado na rede dele (firewall, antivírus, VPN, rede de escola/empresa). Peça para liberar o VideoBridge no Firewall do Windows (redes privadas e públicas), desligar VPN/antivírus por um momento ou trocar de rede (ex.: usar o celular como roteador).';
    else if (!reachable(L)) advice = 'Seu computador não conseguiu descobrir o próprio endereço público: UDP/STUN parece bloqueado na sua rede (firewall, antivírus, VPN). Libere o VideoBridge no Firewall do Windows ou troque de rede.';
    else if (L.relay || R.relay) advice = 'Mesmo com relay (TURN) a conexão falhou: confira usuário/senha e se o servidor TURN aceita UDP (ou TCP/TLS na porta 443) em ⋮ Configurações → Rede.';
    else advice = 'Os dois lados têm endereço público, então o provável é NAT incompatível entre as redes (CGNAT ou NAT simétrico, comum em provedores residenciais). O que resolve: IPv6 ativo nos dois lados, uma das pessoas usar outra rede (ex.: celular) ou configurar um servidor TURN em ⋮ Configurações → Rede (só um lado precisa).';
    return { local: L, remote: R, summary, advice };
  }
  return { parseCandidates, explainFailure };
});
