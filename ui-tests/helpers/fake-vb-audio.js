#!/usr/bin/env node
/**
 * Helper FALSO que fala o mesmo protocolo do native/VbAudio.cs (para testar o app sem Windows).
 * Controle por variáveis de ambiente: FAKE_FAIL=ready|exit|unsupported|badlist, FAKE_BUILD=19045,
 * FAKE_APPS='[{"key":"chrome.exe","name":"Google Chrome","pid":10,"active":true,"peak":0.4}]'
 */
const args = process.argv.slice(2), cmd = args[0];
if (!cmd) process.exit(0); // o executor de testes do Node carrega tudo em test/; sem comando, não faz nada
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const env = process.env;
const APPS = JSON.parse(env.FAKE_APPS || '[{"key":"chrome.exe","name":"Google Chrome","pid":100,"active":true,"peak":0.4},{"key":"spotify.exe","name":"Spotify","pid":200,"active":true,"peak":0.2},{"key":"discord.exe","name":"Discord","pid":300,"active":false,"peak":0}]');

let cfg = { allowNew: arg('--allow-new', '1') !== '0', blocked: new Set((arg('--blocked', '') || '').split('|').filter(Boolean)), allowed: new Set((arg('--allowed', '') || '').split('|').filter(Boolean)) };
const included = (k) => (cfg.blocked.has(k) ? false : cfg.allowed.has(k) ? true : cfg.allowNew);
const withIncl = () => APPS.map((a) => ({ ...a, included: included(a.key), capturing: included(a.key) }));

if (cmd === 'info') {
  const build = Number(env.FAKE_BUILD || 19045);
  process.stdout.write(JSON.stringify({ ok: true, os: '10.0.' + build, build, supported: env.FAKE_FAIL === 'unsupported' ? false : build >= 19041, x64: true }) + '\n');
} else if (cmd === 'list') {
  if (env.FAKE_FAIL === 'badlist') process.stdout.write(JSON.stringify({ ok: false, error: 'GetDefaultAudioEndpoint falhou (HRESULT 0x80070490)' }) + '\n');
  else process.stdout.write(JSON.stringify({ ok: true, apps: withIncl(), selfPid: Number(arg('--self-pid', 0)) }) + '\n');
} else if (cmd === 'capture-test') {
  if (env.FAKE_FAIL === 'testfail') process.stdout.write(JSON.stringify({ ok: false, started: false, error: 'IAudioClient.Initialize falhou em todas as 20 combinacoes de formato/flags: 0x88890021 (AUDCLNT_E_INVALID_STREAM_FLAG) x20' }) + '\n');
  else process.stdout.write(JSON.stringify({ ok: true, started: true, format: 'PCM16/44100 evt+nopersist dur=200000', samples: 4800, peak: 1200, pid: Number(arg('--pid', 0)) }) + '\n');
} else if (cmd === 'probe') {
  process.stdout.write(JSON.stringify({ ok: true, anyOk: env.FAKE_FAIL !== 'testfail', results: [{ name: 'PCM16/44100 evt+nopersist dur=200000', ok: false, hr: '0x88890008 (AUDCLNT_E_UNSUPPORTED_FORMAT)' }, { name: 'PCM16/48000 evt dur=0', ok: env.FAKE_FAIL !== 'testfail', hr: '0x00000000' }] }) + '\n');
} else if (cmd === 'capture') {
  if (env.FAKE_FAIL === 'exit') { process.stderr.write(JSON.stringify({ event: 'fatal', message: 'ActivateAudioInterfaceAsync falhou (HRESULT 0x80070057)' }) + '\n'); process.exit(3); }
  const ev = (o) => process.stderr.write(JSON.stringify(o) + '\n');
  if (env.FAKE_FAIL !== 'ready') ev({ event: 'ready', rate: 48000, channels: 2, bits: 16 });
  let t = 0;
  // 10 ms de seno por vez (480 quadros estéreo s16), em pedaços propositalmente desalinhados
  const timer = setInterval(() => {
    const frames = 480, buf = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin((2 * Math.PI * 440 * (t + i)) / 48000) * 8000); buf.writeInt16LE(v, i * 4); buf.writeInt16LE(v, i * 4 + 2); }
    t += frames;
    const cut = 1001; process.stdout.write(buf.subarray(0, cut)); process.stdout.write(buf.subarray(cut));
  }, 10);
  const apps = setInterval(() => ev({ event: 'apps', apps: withIncl() }), 100);
  let inbuf = '';
  process.stdin.on('data', (d) => {
    inbuf += d.toString('utf8'); let i;
    while ((i = inbuf.indexOf('\n')) >= 0) {
      const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 1);
      if (line === 'QUIT') { clearInterval(timer); clearInterval(apps); process.exit(0); }
      if (line.startsWith('CONFIG\t')) { const p = line.split('\t'); cfg = { allowNew: p[1] === '1', blocked: new Set((p[2] || '').split('|').filter(Boolean)), allowed: new Set((p[3] || '').split('|').filter(Boolean)) }; ev({ event: 'config', allowNew: cfg.allowNew, blocked: [...cfg.blocked], allowed: [...cfg.allowed] }); }
    }
  });
  process.stdin.on('end', () => { clearInterval(timer); clearInterval(apps); process.exit(0); });
} else { process.stdout.write(JSON.stringify({ ok: false, error: 'comando desconhecido' }) + '\n'); process.exit(2); }
