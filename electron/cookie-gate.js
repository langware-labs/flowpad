'use strict';

/*
 * The backend's local cookie-gate token (FLOWPAD-2233).
 *
 * The backend refuses every request that does not present the token it keeps in
 * <flow_home>/instances/<instance>/.cookie_gate (flow_sdk/server/middleware/
 * cookie_gate_middleware.py). This module reads that file so the main process
 * can send it as a header on its own requests (the startup health check) and
 * put it in the app session's cookie jar once the backend is up — every window
 * shares that session, so every page load then carries it.
 *
 * A missing file is normal: an engine that predates the gate never writes one,
 * and a gated engine writes it on the first request it serves. Every reader
 * here answers "no token" rather than throwing, and is re-read on each use.
 *
 * The token is a credential: never log it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HEADER_NAME = 'x-cookie-gate';
// Per port — mirrors the backend's LOCAL_COOKIE_PREFIX / LOCAL_COOKIE_MAX_AGE.
const COOKIE_PREFIX = 'cookie-gate-';
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

/** Same layout as the backend's instance_dir; Electron always uses ~/.flow (as it does for logs). */
function tokenPath(instance = process.env.FLOW_INSTANCE || 'prod', home = os.homedir()) {
  return path.join(home, '.flow', 'instances', instance, '.cookie_gate');
}

/** The token, or null when there is none (yet). */
function readToken(file = tokenPath()) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Headers for a main-process request to the backend: the token, or nothing. */
function gateHeaders(token = readToken()) {
  return token ? { [HEADER_NAME]: token } : {};
}

/** `session.cookies.set` details for the backend at `url` — the backend's own desktop cookie. */
function cookieDetails(url, token, now = Date.now()) {
  const port = new URL(url).port || '80';
  return {
    url,
    name: `${COOKIE_PREFIX}${port}`,
    value: token,
    path: '/',
    httpOnly: true,
    secure: false, // Safari drops Secure cookies on http://localhost; loopback gains nothing from it
    sameSite: 'lax', // same as the backend's cookie: OAuth/login returns are cross-site GET navigations
    expirationDate: Math.floor(now / 1000) + COOKIE_MAX_AGE_S,
  };
}

/**
 * Put the token cookie in `session` for `url` and write it to disk (Electron otherwise
 * flushes every 30 s, so a quick quit would lose it). Resolves false when there is no token to set.
 */
async function injectCookie(session, url, token = readToken()) {
  if (!token) return false;
  await session.cookies.set(cookieDetails(url, token));
  await session.cookies.flushStore();
  return true;
}

module.exports = {
  HEADER_NAME,
  COOKIE_PREFIX,
  COOKIE_MAX_AGE_S,
  tokenPath,
  readToken,
  gateHeaders,
  cookieDetails,
  injectCookie,
};
