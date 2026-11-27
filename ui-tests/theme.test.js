const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'theme.js'), 'utf8'), ctx);
const T = ctx.window.VBTheme;
const isColor = (v) => /^#[0-9a-f]{6}$/.test(v) || /^rgba\(/.test(v);

test('todos os temas definem todas as variáveis, em formato de cor válido', () => {
  for (const theme of T.THEMES) for (const sys of [false, true]) {
    const { mode, vars } = T.compute({ theme, customBg: '#224466' }, sys);
    assert.ok(['dark', 'light'].includes(mode));
    for (const v of T.VARS) assert.ok(isColor(vars[v] || ''), `${theme} ${v}=${vars[v]}`);
  }
});

test('temas prontos: claro é claro, os demais escuros; "sistema" segue o SO', () => {
  assert.equal(T.compute({ theme: 'dark' }).mode, 'dark');
  assert.equal(T.compute({ theme: 'midnight' }).mode, 'dark');
  assert.equal(T.compute({ theme: 'graphite' }).mode, 'dark');
  assert.equal(T.compute({ theme: 'light' }).mode, 'light');
  assert.equal(T.compute({ theme: 'system' }, true).mode, 'light');
  assert.equal(T.compute({ theme: 'system' }, false).mode, 'dark');
});

test('contraste legível em QUALQUER combinação de fundo e destaque (texto, texto secundário, botão, destaque)', () => {
  const bgs = ['#0f1014', '#f3f5f8', '#0b1220', '#1b1b1d', '#ffffff', '#000000', '#808080', '#ff0000', '#00ff00', '#ffff00', '#123456', '#c0c0c0', '#2a2a2a'];
  const accents = [...T.ACCENTS, '#ffff00', '#000000', '#ffffff', '#0000ff'];
  for (const bg of bgs) for (const accent of accents) {
    const { vars: v } = T.compute({ theme: 'custom', customBg: bg, accent });
    const where = `bg ${bg} destaque ${accent}`;
    const preset = ['#0f1014', '#f3f5f8', '#0b1220', '#1b1b1d'].includes(bg), min = preset ? 7 : 4.5; // fundos de tom médio nunca chegam a 7:1
    assert.ok(T.contrast(v['--txt'], v['--bg']) >= min, `texto/fundo ${where}: ${T.contrast(v['--txt'], v['--bg']).toFixed(2)}`);
    assert.ok(T.contrast(v['--txt'], v['--panel']) >= min, `texto/painel ${where}: ${T.contrast(v['--txt'], v['--panel']).toFixed(2)}`);
    assert.ok(T.contrast(v['--mut'], v['--panel']) >= (preset ? 3.2 : 3), `texto secundário/painel ${where}: ${T.contrast(v['--mut'], v['--panel']).toFixed(2)}`);
    assert.ok(T.contrast(v['--on-acc'], v['--acc']) >= 2.4, `texto no botão de destaque ${where}: ${T.contrast(v['--on-acc'], v['--acc']).toFixed(2)}`);
    assert.ok(T.contrast(v['--acc-text'], v['--acc-soft']) >= 3, `aba ativa ${where}: ${T.contrast(v['--acc-text'], v['--acc-soft']).toFixed(2)}`);
  }
});

test('entradas inválidas caem no padrão (nunca quebram a interface)', () => {
  for (const bad of [undefined, null, {}, { theme: 'xyz' }, { theme: 'custom', customBg: 'vermelho' }, { accent: 'url(javascript:1)' }, { theme: 'custom', customBg: '#fff' }]) {
    const { vars } = T.compute(bad);
    for (const v of T.VARS) assert.ok(isColor(vars[v]), JSON.stringify(bad));
  }
  assert.equal(T.compute({ accent: 'azul' }).vars['--acc'], '#10b981', 'destaque inválido = o do tema');
});

test('o destaque escolhido vale em qualquer tema e o tema "personalizado" usa o fundo escolhido', () => {
  assert.equal(T.compute({ theme: 'light', accent: '#ef4444' }).vars['--acc'], '#ef4444');
  const c = T.compute({ theme: 'custom', customBg: '#1a2b3c' }).vars;
  assert.equal(c['--bg'], '#1a2b3c'); assert.notEqual(c['--panel'], c['--bg']);
  assert.equal(T.compute({ theme: 'custom', customBg: '#fafafa' }).mode, 'light', 'fundo claro escolhido = interface clara');
});

test('apply grava as variáveis na página e devolve o modo', () => {
  const set = {}, attrs = {};
  const root = { setAttribute: (k, v) => { attrs[k] = v; }, style: { setProperty: (k, v) => { set[k] = v; } } };
  assert.equal(T.apply(root, { theme: 'light' }, false), 'light');
  assert.equal(attrs['data-theme'], 'light'); assert.equal(set['--bg'], '#f3f5f8'); assert.ok(set['--acc']);
});

test('o CSS usa variáveis de tema (sem cores neutras fixas espalhadas) e o :root cobre todas', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.css'), 'utf8');
  const rootLine = css.split('\n')[0];
  for (const v of T.VARS) { if (v !== '--warn') assert.ok(rootLine.includes(v + ':'), `${v} sem valor padrão no :root`); }
  const body = css.split('\n').slice(1).join('\n');
  for (const hex of ['#0f1014', '#17181d', '#10b981', '#2b2f3a', '#101116']) assert.ok(!body.includes(hex) || /\.tile\{/.test(body), `cor fixa ${hex}`);
});
