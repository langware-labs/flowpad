'use strict';

/*
 * Upload the "Send Report" support bundle to the hub's anonymous intake
 * (POST {cloud}/api/v1/diagnosis-report/bundle, hub routers/support_bundle.py), which stores it
 * in GCS and notifies the team. The zip is the raw request body; the optional email and
 * the app/platform facts travel as x-flowpad-* headers and end up as object metadata.
 * The hub answers {data: {submission_id}} — the reference the user can quote to support.
 */

const fs = require('fs');
const { API_PREFIX } = require('./uv-manager');

// Header values must be one printable-ASCII line (undici refuses anything else, and the
// hub flattens whitespace anyway); same cap as the hub's _MAX_META_CHARS.
const MAX_HEADER_CHARS = 320;

function headerValue(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HEADER_CHARS);
}

/**
 * @param {object} o
 * @param {string} o.cloudUrl   hub base URL (FLOWPAD_CLOUD_URL)
 * @param {string} o.zipPath    the bundle buildSupportZip wrote
 * @param {string} [o.email]    the user's optional reply address ('' → anonymous)
 * @param {{app?: string, platform?: string, instance?: string}} [o.info]
 * @param {Function} [o.fetchImpl]  injected for tests
 * @returns {Promise<{ok: true, submissionId: string} | {ok: false, error: string}>}
 */
async function uploadSupportBundle({ cloudUrl, zipPath, email = '', info = {}, fetchImpl = fetch }) {
  let body;
  try {
    body = await fs.promises.readFile(zipPath);
  } catch (err) {
    return { ok: false, error: `could not read ${zipPath}: ${err.message}` };
  }
  const headers = { 'Content-Type': 'application/zip' };
  const meta = {
    'x-flowpad-email': email,
    'x-flowpad-app-version': info.app,
    'x-flowpad-platform': info.platform,
    'x-flowpad-instance': info.instance,
  };
  for (const [name, raw] of Object.entries(meta)) {
    const value = headerValue(raw);
    if (value) headers[name] = value;
  }

  let res;
  try {
    res = await fetchImpl(`${cloudUrl}${API_PREFIX}/diagnosis-report/bundle`, { method: 'POST', headers, body });
  } catch (err) {
    return { ok: false, error: `could not reach the Flowpad service: ${err.message}` };
  }
  let data = null;
  try { data = await res.json(); } catch { /* a proxy error page has no JSON body */ }
  if (!res.ok) {
    // The hub puts its client-intended message in `detail` (HTTPException) or `message` (envelope).
    const message = (data && (data.detail || data.message)) || `the service answered HTTP ${res.status}`;
    return { ok: false, error: message };
  }
  const submissionId = data && data.data && data.data.submission_id;
  if (!submissionId) return { ok: false, error: 'the service did not return a submission id' };
  return { ok: true, submissionId };
}

module.exports = { uploadSupportBundle, headerValue, MAX_HEADER_CHARS };
