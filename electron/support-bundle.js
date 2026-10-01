'use strict';

/*
 * The "Share with us" bundle: the newest desktop log and the newest backend-server log, a small
 * info.txt, zipped, with obvious secrets masked — plus the mailto: link that opens the user's own
 * mail client. A mailto: URL cannot carry an attachment, so the caller also reveals the zip in the
 * file manager and the mail body says which file to attach. Nothing is sent by the app itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createZip } = require('./zip-writer');

// Only the tail of each log goes in: the cause of a startup failure is at the end, and a mail
// attachment has to stay small. (A size bound on what we attach, not a wait or timeout.)
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAILTO_MAX_LENGTH = 1800; // several Windows mail handlers truncate longer command lines

const MASK = '[REDACTED]';
const REDACTIONS = [
  [/(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi, `$1$2${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${MASK}`],
  [/((?:token|secret|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|sod[_-]?key|private[_-]?key)["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, `$1${MASK}`],
  [/\bfp_(?:live|test)_[A-Za-z0-9]{8,}/g, MASK], // Flowpad API keys, in any context
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, MASK],
  [/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, `$1${MASK}@`],
];

/** Mask obvious credentials. Paths (incl. the user name in them) are deliberately NOT touched. */
function redact(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

/** The newest regular file in `dir`, or null. */
function newestFile(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || name.startsWith('.')) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, name, mtimeMs: st.mtimeMs, size: st.size };
  }
  return best;
}

/** The last `maxBytes` of a file as text, starting at a line boundary. '' when unreadable. */
function tailText(file, maxBytes = MAX_LOG_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = `[… earlier output omitted: showing the last ${buf.length} bytes …]\n${nl >= 0 ? text.slice(nl + 1) : text}`;
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * @param {{label: string, dir: string}[]} sources  directories to take the newest log from
 * @returns {{label: string, name: string, path: string, text: string}[]}
 */
function collectLogs(sources, maxBytes = MAX_LOG_BYTES) {
  const out = [];
  for (const { label, dir } of sources) {
    const file = newestFile(dir);
    if (!file) continue;
    out.push({ label, name: file.name, path: file.path, text: redact(tailText(file.path, maxBytes)) });
  }
  return out;
}

/** Write the zip into `outDir`; returns { zipPath, bytes, included, missing }. */
function buildSupportZip({ sources, info, detail, outDir = os.tmpdir(), now = new Date() }) {
  const logs = collectLogs(sources);
  const entries = [];
  const lines = [
    `Flowpad support bundle — ${now.toISOString()}`,
    ...Object.entries(info || {}).map(([k, v]) => `${k}: ${v}`),
    '',
    'Included (last part of each, obvious tokens/passwords masked; file paths are left as they are):',
    ...logs.map((l) => `  ${l.label}: ${l.path}`),
    ...sources.filter((s) => !logs.some((l) => l.label === s.label)).map((s) => `  ${s.label}: (no log found in ${s.dir})`),
  ];
  if (detail) lines.push('', 'Error shown to the user:', redact(detail));
  entries.push({ name: 'info.txt', data: lines.join('\n') + '\n', date: now });
  for (const l of logs) entries.push({ name: `${l.label}-${l.name}`, data: l.text, date: now });

  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipPath = path.join(outDir, `flowpad-support-${stamp}.zip`);
  const bytes = createZip(entries);
  fs.writeFileSync(zipPath, bytes);
  return {
    zipPath,
    bytes: bytes.length,
    included: logs.map((l) => l.label),
    missing: sources.filter((s) => !logs.some((l) => l.label === s.label)).map((s) => s.label),
  };
}

const SUBJECT_TITLE = 'Flowpad startup problem';

/** Fixed title + the local date, so a team mailbox threads/sorts a day's reports together. */
function supportSubject(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${SUBJECT_TITLE} - ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A mailto: URL that stays short enough for every handler; the body is trimmed to fit. */
function buildMailtoUrl({ to, subject, body }) {
  const make = (b) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  let text = body;
  let url = make(text);
  while (url.length > MAILTO_MAX_LENGTH && text.length > 40) {
    text = `${text.slice(0, Math.max(40, Math.floor(text.length * 0.85)))}…`;
    url = make(text);
  }
  return url;
}

module.exports = { redact, newestFile, tailText, collectLogs, buildSupportZip, buildMailtoUrl, supportSubject, SUBJECT_TITLE, MAX_LOG_BYTES, MAILTO_MAX_LENGTH };
