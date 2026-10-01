'use strict';

/*
 * Keep secrets out of the desktop log.
 *
 * The log is a file on disk that users email to us (and that "Share with us" bundles), so anything written
 * to it is effectively published. Found in real user logs (2026-09-30): every flowpad:// deep link was logged
 * whole, and the login callback carries a live API key — `flowpad://auth/login_callback?flowpad-api-key=fp_live_…`.
 *
 * Two layers, because either alone has gaps:
 *   1. redactUrl() at the sites that log a URL (the intent is visible where the URL is logged);
 *   2. installLogRedaction(): an electron-log hook that runs redact() over EVERY message before any transport
 *      writes it — the net for whatever a future log line interpolates (uv stderr, an error, an env dump).
 * Both use support-bundle's redact(), the single place credentials are recognised.
 */

const { redact } = require('./support-bundle');

// Query/fragment parameter NAMES whose value is a credential. Matched on whole name parts, so `key` and
// `api-key` and `access_token` match but `keyboard` and `monkey` do not.
const SENSITIVE_PARAM = /(^|[-_.])(api[-_]?key|key|token|secret|password|passwd|pwd|code|auth|authorization|sig|signature|session|cookie|credential|jwt|bearer)s?($|[-_.])/i;

/** A URL safe to write to the log: credential-carrying query/fragment values and user:password@ removed. */
function redactUrl(url) {
  const text = String(url ?? '');
  const masked = text.replace(/([?&#])([^=&#]*)=([^&#]*)/g, (whole, sep, key, value) => {
    let name = key;
    try { name = decodeURIComponent(key); } catch { /* keep the raw name */ }
    return SENSITIVE_PARAM.test(name) ? `${sep}${key}=[REDACTED]` : whole;
  });
  return redact(masked); // second pass: userinfo, bare tokens, fp_live_…
}

/** electron-log hook body: a copy of `message` whose string/Error data has been through redact(). */
function redactLogMessage(message) {
  if (!message || !Array.isArray(message.data)) return message;
  const data = message.data.map((item) => {
    if (typeof item === 'string') return redact(item);
    if (item instanceof Error) return redact(item.stack || `${item.name}: ${item.message}`);
    return item;
  });
  return { ...message, data }; // hooks run once per transport: never mutate the shared message
}

/** Register the redaction hook on an electron-log instance (idempotent). */
function installLogRedaction(log) {
  if (log.hooks.some((h) => h && h.__flowpadRedaction)) return;
  const hook = (message) => redactLogMessage(message);
  hook.__flowpadRedaction = true;
  log.hooks.push(hook);
}

module.exports = { redactUrl, redactLogMessage, installLogRedaction, SENSITIVE_PARAM };
