'use strict';
/**
 * Temas: gera TODAS as variáveis de cor da interface a partir de duas cores (fundo e destaque).
 * Os temas prontos são só pares (fundo, destaque); "personalizado" deixa o usuário escolher o fundo.
 * Funções puras (sem DOM) para poderem ser testadas; `apply` é a única que toca a página.
 */
(() => {
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const clamp = (x) => Math.min(255, Math.max(0, x));
  const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v)).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = toRgb(a), y = toRgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = (h) => {
    const [r, g, b] = toRgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const PRESETS = {
    dark: { name: 'Escuro', bg: '#0f1014', acc: '#10b981' },
    light: { name: 'Claro', bg: '#f3f5f8', acc: '#0f9f6e' },
    midnight: { name: 'Meia-noite', bg: '#0b1220', acc: '#3b82f6' },
    graphite: { name: 'Grafite', bg: '#1b1b1d', acc: '#a78bfa' },
  };
  const THEMES = ['dark', 'light', 'midnight', 'graphite', 'system', 'custom'];
  const ACCENTS = ['#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#14b8a6', '#64748b'];

  const baseVars = (base, light) => (light ? {
    '--bg': base, '--panel': mix(base, '#ffffff', 0.7), '--panel2': mix(base, '#ffffff', 0.4), '--line': mix(base, '#000000', 0.1),
    '--surf': mix(base, '#000000', 0.07), '--surf-h': mix(base, '#000000', 0.12), '--input': mix(base, '#ffffff', 0.85), '--side': mix(base, '#000000', 0.03),
    '--row': mix(base, '#000000', 0.06), '--line2': mix(base, '#000000', 0.17), '--line3': mix(base, '#000000', 0.26), '--thumb': mix(base, '#000000', 0.17),
    '--top': mix(base, '#ffffff', 0.8), '--txt': '#1a1d24', '--mut': mix('#1a1d24', base, 0.4),
    '--scrim': 'rgba(15,20,30,.5)', '--tip-bg': '#1f2430', '--tip-txt': '#f3f5f8',
    '--danger': '#c4262d', '--danger-bg': '#fbe3e4', '--err': '#c4262d', '--gold': '#b7791f', '--ok': '#0f9f6e', '--warn': '#a16207', '--bad': '#d92d33',
    '--shadow-s': 'rgba(30,40,60,.12)', '--shadow': 'rgba(30,40,60,.2)', '--shadow-l': 'rgba(30,40,60,.3)',
  } : {
    '--bg': base, '--panel': mix(base, '#ffffff', 0.045), '--panel2': mix(base, '#ffffff', 0.085), '--line': mix(base, '#ffffff', 0.15),
    '--surf': mix(base, '#ffffff', 0.17), '--surf-h': mix(base, '#ffffff', 0.23), '--input': mix(base, '#ffffff', 0.01), '--side': mix(base, '#ffffff', 0.03),
    '--row': mix(base, '#ffffff', 0.105), '--line2': mix(base, '#ffffff', 0.215), '--line3': mix(base, '#ffffff', 0.29), '--thumb': mix(base, '#ffffff', 0.18),
    '--top': mix(base, '#ffffff', 0.065), '--txt': '#e8eaee', '--mut': mix('#e8eaee', base, 0.42),
    '--scrim': 'rgba(0,0,0,.72)', '--tip-bg': mix(base, '#000000', 0.4), '--tip-txt': '#e8eaee',
    '--danger': '#ff6b72', '--danger-bg': '#3a2226', '--err': '#ff8a85', '--gold': '#f5c542', '--ok': '#34d399', '--warn': '#e8b24a', '--bad': '#e5252a',
    '--shadow-s': 'rgba(0,0,0,.28)', '--shadow': 'rgba(0,0,0,.5)', '--shadow-l': 'rgba(0,0,0,.6)',
  });

  /** Cor do destaque usada como TEXTO sobre o fundo suave da aba ativa: escurece/clareia até ficar legível. */
  const fitText = (acc, soft, light) => {
    const target = light ? '#000000' : '#ffffff';
    for (let t = light ? 0.32 : 0.55; t <= 1.001; t += 0.08) { const c = mix(acc, target, t); if (contrast(c, soft) >= 4) return c; }
    return target;
  };
  const accentVars = (acc, base, light) => ({
    '--acc': acc,
    '--accd': mix(acc, '#000000', 0.2),
    // texto branco nos botões (o visual do app) enquanto o destaque não for claro demais; aí passa a texto escuro
    '--on-acc': contrast(acc, '#ffffff') >= 2.4 ? '#ffffff' : '#10131a',
    '--acc-on': mix(acc, '#000000', light ? 0.12 : 0.28),
    '--acc-text': fitText(acc, mix(base, acc, light ? 0.16 : 0.22), light),
    '--acc-soft': mix(base, acc, light ? 0.16 : 0.22),
    '--glow': mix(base, acc, light ? 0.14 : 0.12),
  });

  const VARS = [...Object.keys(baseVars('#000000', false)), ...Object.keys(accentVars('#000000', '#000000', false))];

  /** Entrada: { theme, accent, customBg }. Saída: { mode: 'dark'|'light', vars } (entradas inválidas caem nos padrões). */
  function compute(input, systemLight = false) {
    const a = input && typeof input === 'object' ? input : {};
    const theme = THEMES.includes(a.theme) ? a.theme : 'dark';
    const key = theme === 'system' ? (systemLight ? 'light' : 'dark') : theme;
    const preset = PRESETS[key] || PRESETS.dark;
    const base = (key === 'custom' && HEX.test(a.customBg || '')) ? a.customBg.toLowerCase() : preset.bg;
    const acc = HEX.test(a.accent || '') ? a.accent.toLowerCase() : preset.acc;
    const light = lum(base) > 0.18; // ponto em que texto claro e escuro têm o mesmo contraste
    const vars = { ...baseVars(base, light), ...accentVars(acc, base, light) };
    // fundos de tom médio (cinza #808080…): nenhum texto "suave" chega a bom contraste; usa o extremo (branco/preto puro)
    if (contrast(vars['--txt'], base) < 7) { vars['--txt'] = light ? '#000000' : '#ffffff'; vars['--mut'] = mix(vars['--txt'], base, 0.3); }
    return { mode: light ? 'light' : 'dark', vars };
  }

  /** Aplica na página (`root` = <html>). Devolve o modo ('dark'|'light') para a janela acompanhar. */
  function apply(root, a, systemLight) {
    const { mode, vars } = compute(a, !!systemLight);
    root.setAttribute('data-theme', mode);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    return mode;
  }

  const DEFAULT = { theme: 'dark', accent: '', customBg: PRESETS.dark.bg };
  window.VBTheme = { DEFAULT, PRESETS, THEMES, ACCENTS, VARS, HEX, compute, apply, contrast, lum, mix };
})();
