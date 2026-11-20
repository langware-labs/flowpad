/**
 * forkit — a list of issues on the left, the live fork working the selected one in the centre.
 *
 * The rows (forkit.issue, one dataset) are the only state: status and the fork's process id live there,
 * so another window, an agent or a reload sees the same thing. A fork is made the first time an issue
 * is opened (agentic_process/<root>/fork, then /open with the issue's prompt); ✓ Done closes it.
 */
import * as sdk from '/sdk/flowpad-sdk.js';

const CFG = window.FORKIT || {};
const $ = (id) => document.getElementById(id);
const state = { rows: [], filter: 'open', sel: null, info: null, busy: new Set(), ds: null };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// The page-state key (flow-js skill §4): a frame cannot inherit it, so its URL carries it.
const pageKey = () => globalThis.__FLOWPAD_STATE_KEY__ || new URLSearchParams(location.search).get('state');
const framed = (url) => { const k = pageKey(); if (!k || /[?&]state=/.test(url)) return url;
  const [u, h] = url.split('#'); return `${u}${u.includes('?') ? '&' : '?'}state=${encodeURIComponent(k)}${h ? '#' + h : ''}`; };
const fail = (msg) => { $('err').hidden = false; $('err').textContent = msg; console.error('[forkit]', msg); };
const post = async (path, body) => {
  const res = await sdk.apiClient.post(path, body || {});
  const data = res?.data ?? res;
  if (data?.status === 'fail' || data?.success === false) throw new Error(data?.message || `${path} failed`);
  return data?.data ?? data;
};

async function load() {
  const { rows } = await state.ds.query({ match: { 'input.run': CFG.run }, order_by: { 'input.order': 'asc' }, limit: 1000 });
  state.rows = rows;
  render();
}

/** The fork for an issue: made once, on first open. Two clicks never make two forks. */
async function ensureFork(row) {
  if (row.input.process_id || row.input.status === 'done' || state.busy.has(row.key)) return;
  state.busy.add(row.key);
  render();
  try {
    const made = await post(`/graph/agentic_process/${row.input.root}/fork`, { visible: false });
    if (!made?.id) throw new Error('the fork returned no process id');
    await post(`/graph/agentic_process/${made.id}/open`, { instruction: row.input.prompt });
    await state.ds.put(row.key, { input: { ...row.input, process_id: made.id } }, { expected: row.version });
  } catch (e) {
    fail(`Could not fork #${row.input.id}: ${e?.message || e}`);
  } finally {
    state.busy.delete(row.key);
    render();   // the write itself comes back through onRowsChanged
  }
}

async function setStatus(row, status) {
  try {
    if (status === 'done' && row.input.process_id) {
      try { await post(`/graph/agentic_process/${row.input.process_id}/close`); }
      catch (e) { console.warn('[forkit] close', e); }   // already gone: the row still moves to done
    }
    await state.ds.put(row.key, { input: { ...row.input, status, process_id: null } }, { expected: row.version });
  } catch (e) {
    fail(`Could not change #${row.input.id}: ${e?.message || e}`);
  }
}

function select(key) {
  state.sel = key;
  const row = state.rows.find((r) => r.key === key);
  render();
  if (row) ensureFork(row);
}

function renderMain() {
  const main = $('main');
  const row = state.rows.find((r) => r.key === state.sel);
  const pid = row?.input.process_id;
  const want = pid ? `/win/shell/agentic_process-${pid}` : null;
  const frame = main.querySelector('iframe');
  if (want && frame?.dataset.src === want) return;   // keep the live terminal; never reload it on a render
  main.className = want ? '' : 'empty';
  if (!want) {
    const msg = !row ? 'Pick an issue to start its fork.'
      : row.input.status === 'done' ? `#${esc(row.input.id)} is done. ↺ Open starts a new fork.`
        : state.busy.has(row.key) ? `Forking #${esc(row.input.id)} from the root…` : 'Starting…';
    main.innerHTML = `<div>${msg}</div>`;
    return;
  }
  main.innerHTML = `<div class="th"><b>#${esc(row.input.id)} · ${esc(row.input.title)}</b>`
    + `<span>${esc(pid.slice(0, 8))} · forked from ${esc(row.input.root.slice(0, 8))}</span></div>`
    + `<iframe data-src="${want}" src="${esc(framed(want))}" title="terminal"></iframe>`;
}

function render() {
  const all = state.rows;
  const done = all.filter((r) => r.input.status === 'done').length;
  $('bar').style.width = `${all.length ? (100 * done) / all.length : 0}%`;
  $('count').textContent = `${done} / ${all.length} done`;
  const counts = { open: all.length - done, done, all: all.length };
  for (const b of $('filter').children) {
    b.classList.toggle('on', b.dataset.f === state.filter);
    b.textContent = `${b.dataset.f[0].toUpperCase()}${b.dataset.f.slice(1)} ${counts[b.dataset.f]}`;
  }
  const shown = all.filter((r) => state.filter === 'all' || r.input.status === state.filter);
  $('list').innerHTML = shown.map((r) => {
    const i = r.input, isDone = i.status === 'done';
    const dot = state.busy.has(r.key) ? 'busy' : i.process_id ? 'live' : '';
    return `<li class="it${r.key === state.sel ? ' sel' : ''}${isDone ? ' dn' : ''}" data-key="${esc(r.key)}">`
      + `<span class="dot ${dot}"></span><b>#${esc(i.id)}</b><span class="t" title="${esc(i.title)}">${esc(i.title)}</span>`
      + `<button class="nf${state.info === r.key ? ' on' : ''}" data-info title="What is it about">ⓘ</button>`
      + `<button class="st" data-status="${isDone ? 'open' : 'done'}" title="${isDone ? 'Change status to open' : 'Change status to done'}">${isDone ? '↺ Open' : '✓ Done'}</button>`
      + `<small>${i.process_id ? `fork ${esc(i.process_id.slice(0, 8))}` : isDone ? 'closed' : 'not started'}</small>`
      + (state.info === r.key ? `<p class="desc">${esc(i.desc || 'No description.')}</p>` : '')
      + '</li>';
  }).join('');
  renderMain();
}

$('list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-key]');
  if (!li) return;
  const row = state.rows.find((r) => r.key === li.dataset.key);
  if (ev.target.closest('[data-info]')) { state.info = state.info === row.key ? null : row.key; render(); return; }
  const st = ev.target.closest('[data-status]');
  if (st) { setStatus(row, st.dataset.status); return; }
  select(row.key);
});
$('filter').addEventListener('click', (ev) => {
  if (ev.target.dataset.f) { state.filter = ev.target.dataset.f; render(); }
});

(async () => {
  $('title').textContent = CFG.title || 'forkit';
  $('root').textContent = CFG.root || '';
  try {
    sdk.applyHostTheme?.();
    await sdk.initSdk();
    const found = await sdk.Dataset.forKind(CFG.kind);
    const ds = found.find((d) => d.id === CFG.dataset) || found[0];
    if (!ds) throw new Error(`no ${CFG.kind} dataset — run scripts/forkit.py again`);
    state.ds = ds;
    ds.onRowsChanged(() => load());
    await load();
  } catch (e) {
    fail(`forkit could not load: ${e?.message || e}`);
  }
})();
