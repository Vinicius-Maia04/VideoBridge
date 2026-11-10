const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'ui');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');

for (const [html, js] of [['room.html', 'room.js']]) {
  test(`${js}: todo $('#id') existe em ${html}`, () => {
    const ids = new Set([...read(html).matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...read(js).matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
    ['#btnStart'].length; // sanity
    for (const id of used) assert.ok(ids.has(id), `#${id} usado em ${js} mas ausente em ${html}`);
    // seletores passados em listas/arrays: '#id'
    for (const m of read(js).matchAll(/'#([\w-]+)'/g)) assert.ok(ids.has(m[1]), `#${m[1]} ausente em ${html}`);
  });
  test(`${html}: CSP estrita, sem script/estilo inline`, () => {
    const h = read(html);
    assert.match(h, /Content-Security-Policy/);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(h), 'script inline');
    assert.ok(!/\sstyle="/.test(h), 'atributo style inline');
    assert.ok(!/unsafe-inline|unsafe-eval/.test(h));
  });
}
test('scripts referenciados nos HTML existem', () => {
  for (const f of ['room.html']) {
    for (const m of read(f).matchAll(/<script src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(R, m[1])), m[1]);
    for (const m of read(f).matchAll(/href="([^"]+\.css)"/g)) assert.ok(fs.existsSync(path.join(R, m[1])), m[1]);
  }
});
test('renderer nunca usa innerHTML/eval (convites são dados não confiáveis)', () => {
  for (const f of ['room.js', 'common.js']) assert.ok(!/innerHTML|outerHTML|eval\(|new Function/.test(read(f)), f);
});
test('canais IPC da ponte (bridge.js) têm handler no Rust (bridge.rs)', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'crates/vb-app/src/bridge.js'), 'utf8');
  const rs = fs.readFileSync(path.join(__dirname, '..', 'crates/vb-app/src/bridge.rs'), 'utf8');
  const chans = [...pre.matchAll(/invoke\('([\w:]+)'/g)].map((m) => m[1]);
  assert.ok(chans.length > 15);
  for (const c of chans) assert.ok(rs.includes(`"${c}"`), `sem handler: ${c}`);
  for (const m of pre.matchAll(/send\('([\w:]+)'/g)) assert.ok(rs.includes(`"${m[1]}"`), `sem handler: ${m[1]}`);
});
