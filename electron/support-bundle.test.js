'use strict';

/*
 * Tests for ./zip-writer.js and ./support-bundle.js — the "Share with us" bundle.
 * Run: `node electron/support-bundle.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { createZip, crc32 } = require('./zip-writer');
const { redact, newestFile, tailText, collectLogs, buildSupportZip, buildMailtoUrl } = require('./support-bundle');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

// A tiny independent ZIP reader (central directory), so the writer is checked by a reader that
// shares no code with it.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.strictEqual(raw.length, usize, `${name}: size`);
    assert.strictEqual(crc32(raw), crc, `${name}: crc`);
    files[name] = raw.toString('utf8');
    p += 46 + nlen;
  }
  return files;
}

// ── zip-writer ──────────────────────────────────────────────────────────────
{
  const big = 'line of log text\n'.repeat(5000);
  const zip = createZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/שלום.log', data: big },
    { name: 'empty.txt', data: '' },
  ]);
  const files = readZip(zip);
  eq(Object.keys(files), ['a.txt', 'dir/שלום.log', 'empty.txt'], 'names round-trip, including UTF-8');
  eq(files['a.txt'], 'hello', 'content round-trips');
  eq(files['dir/שלום.log'], big, 'large content round-trips through deflate');
  eq(files['empty.txt'], '', 'an empty file round-trips');
  ok(zip.length < big.length / 10, 'repetitive log text is actually compressed');
  eq(crc32(Buffer.from('123456789')), 0xcbf43926, 'crc32 matches the standard check value');

  // A real unzip must accept it too (skipped where python3 is missing).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zipw-'));
  try {
    const f = path.join(tmp, 't.zip');
    fs.writeFileSync(f, zip);
    const r = spawnSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))', f], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') console.log('  (python3 not available: skipped the independent zipfile check)');
    else eq(r.stdout.trim(), '3', 'python zipfile opens the archive and every CRC checks out');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── redact ──────────────────────────────────────────────────────────────────
{
  const M = '[REDACTED]';
  ok(!redact('Authorization: Bearer abcdefghijklmnop123456').includes('abcdefghijklmnop123456'), 'bearer header masked');
  eq(redact('AZURE_CLIENT_SECRET=hunter2hunter2'), `AZURE_CLIENT_SECRET=${M}`, 'KEY=value secrets masked, key kept');
  eq(redact('password: "s3cret!"'), `password: "${M}"`, 'quoted password masked');
  ok(!redact('token ghp_abcdefghijklmnopqrstuvwx1234').includes('ghp_abcdefghij'), 'GitHub token masked');
  ok(!redact('key sk-abcdefghijklmnopqrstuvwxyz0123').includes('sk-abcdefghij'), 'sk- key masked');
  ok(!redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk').includes('eyJhbGci'), 'JWT masked');
  eq(redact('git clone https://user:pa55w0rd@github.com/x/y'), `git clone https://user:${M}@github.com/x/y`, 'URL credentials masked');
  const plain = '[uv] Running: C:\\Users\\Tzahi\\AppData\\Roaming\\uv\\tools\\flowpad\\Scripts\\flow.exe stop';
  eq(redact(plain), plain, 'ordinary log lines and paths are left untouched');
  eq(redact(null), '', 'null → empty');
}

// ── tail / newest / collect ─────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
try {
  const desk = path.join(tmp, 'main_desktop');
  const server = path.join(tmp, 'server');
  fs.mkdirSync(desk); fs.mkdirSync(server);
  const write = (dir, name, text, ageSec) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    const t = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(f, t, t);
    return f;
  };
  write(desk, 'old.log', 'old desktop\n', 500);
  const newestDesk = write(desk, 'new.log', 'new desktop token=abcdef123456\n', 10);
  write(desk, '.DS_Store', 'junk', 1);
  write(server, 'server.log', 'server line\n', 5);

  eq(newestFile(desk).name, 'new.log', 'newest log wins; dotfiles are ignored');
  eq(newestFile(path.join(tmp, 'nope')), null, 'a missing dir → null');

  const many = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
  const f = write(tmp, 'many.log', many, 1);
  const t = tailText(f, 100);
  ok(t.startsWith('[… earlier output omitted'), 'a truncated tail says so');
  ok(t.trimEnd().endsWith('line 999'), 'the tail keeps the END of the file');
  ok(/\nline \d+\n/.test(t), 'the tail starts on a line boundary');
  eq(tailText(path.join(tmp, 'nope')), '', 'an unreadable file → empty text');
  eq(tailText(f, 10_000_000), many, 'a small file is returned whole');

  const logs = collectLogs([{ label: 'desktop', dir: desk }, { label: 'server', dir: server }, { label: 'gone', dir: path.join(tmp, 'gone') }]);
  eq(logs.map((l) => l.label), ['desktop', 'server'], 'missing sources are skipped');
  ok(logs[0].text.includes('token=[REDACTED]') && !logs[0].text.includes('abcdef123456'), 'collected logs are redacted');

  // ── the whole bundle ──
  const out = path.join(tmp, 'out'); fs.mkdirSync(out);
  const res = buildSupportZip({
    sources: [{ label: 'desktop', dir: desk }, { label: 'server', dir: server }, { label: 'monitor', dir: path.join(tmp, 'gone') }],
    info: { app: '0.2.46', platform: 'linux x64' },
    detail: 'Command failed\nAuthorization: Bearer abcdefghijklmnop123456',
    outDir: out,
    now: new Date('2026-09-30T12:34:56Z'),
  });
  eq(path.basename(res.zipPath), 'flowpad-support-2026-09-30T12-34-56.zip', 'the zip is named by time');
  eq(res.included, ['desktop', 'server'], 'included sources reported');
  eq(res.missing, ['monitor'], 'missing sources reported');
  const files = readZip(fs.readFileSync(res.zipPath));
  eq(Object.keys(files).sort(), ['desktop-new.log', 'info.txt', 'server-server.log'], 'zip holds info + the newest log of each source');
  ok(files['info.txt'].includes('app: 0.2.46') && files['info.txt'].includes('monitor: (no log found'), 'info.txt describes what is and is not there');
  ok(files['info.txt'].includes('Bearer [REDACTED]') && !files['info.txt'].includes('abcdefghijklmnop123456'), 'the shown error is redacted too');
  ok(files['desktop-new.log'].includes('new desktop') && !files['desktop-new.log'].includes('abcdef123456'), 'log inside the zip is redacted');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// ── mailto ──────────────────────────────────────────────────────────────────
{
  const url = buildMailtoUrl({ to: 'diagnosis@langware.ai', subject: 'Flowpad – startup problem', body: 'line1\nline2 & more' });
  ok(url.startsWith('mailto:diagnosis@langware.ai?subject=Flowpad%20%E2%80%93%20startup%20problem&body='), 'recipient and encoded subject');
  ok(url.includes('line1%0Aline2%20%26%20more'), 'body is encoded');
  const long = buildMailtoUrl({ to: 'a@b.c', subject: 's', body: 'x'.repeat(20000) });
  ok(long.length <= 1800, `a huge body is trimmed to stay under the handler limit (${long.length})`);
  ok(long.endsWith(encodeURIComponent('…')), 'a trimmed body ends with an ellipsis');
}

console.log(`support-bundle.test.js: ${passed} assertions passed`);
