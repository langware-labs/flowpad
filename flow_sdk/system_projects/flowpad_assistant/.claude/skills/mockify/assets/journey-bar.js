/* mockify journey bar v2 — paste inline as the LAST script in every mock's <body>. Self-contained.
 * Contract (what the page defines, the data it reads and writes, the controls): journey-bar.md. */
(() => {
  const CFG = window.MOCKIFY || {};
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem('mockify:' + k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem('mockify:' + k, JSON.stringify(v)); } catch { /* no storage here */ } },
  };
  const docStyle = document.createElement('style');
  docStyle.textContent = '[data-step][hidden]{display:none!important}';
  document.head.append(docStyle);

  let J = CFG.journey || [];       // the steps (from the mock row once loaded): {id, app, title, note?, branch_of?, when?, decisions?[]}
  let cur = 0;
  const data = { sdk: null, mock: null, mocksDs: null, fbDs: null, rows: [], error: '' };
  const openRows = () => data.rows.filter((r) => r.input.status === 'open');
  const stepRows = () => data.rows.filter((r) => r.input.step === J[cur]?.id);

  const isBranch = (s) => !!s.branch_of;
  const find = (id) => J.findIndex((s) => s.id === id);   // -1 when there is no such step
  const mainAfter = (i) => { for (let k = i + 1; k < J.length; k++) if (!isBranch(J[k])) return k; return i; };
  const mainBefore = (i) => { for (let k = i - 1; k >= 0; k--) if (!isBranch(J[k])) return k; return i; };
  const show = (id) => {
    if (typeof window.mockGo === 'function') return window.mockGo(id);
    document.querySelectorAll('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== id; });
  };
  const go = (i, record = true) => {
    if (!J.length) return;
    cur = Math.min(J.length - 1, Math.max(0, i));
    const id = J[cur].id;
    if (record && location.hash.slice(1) !== id) history.pushState(null, '', '#' + id);
    show(id);
    render();
    requestAnimationFrame(contrast);
  };

  // ── the host: a shadow root, so the mock's CSS and the bar's never touch ──
  const host = document.createElement('div');
  host.setAttribute('data-mockify', '');
  const place = (x, y) => {
    const w = host.offsetWidth || 300, h = host.offsetHeight || 40;
    x = Math.max(0, Math.min(innerWidth - w, x));
    y = Math.max(0, Math.min(innerHeight - h, y));
    host.style.cssText = `position:fixed;z-index:2147483647;left:${x}px;top:${y}px;`;
  };
  const reclamp = () => { if (host.style.left && !host.style.transform) { const r = host.getBoundingClientRect(); place(r.left, r.top); } };
  // Top centre by default (fast mocks keep 52px clear); a real-mode mock sets MOCK_BAR_AT = 'bottom'.
  host.style.cssText = window.MOCK_BAR_AT === 'bottom' ? 'position:fixed;z-index:2147483647;bottom:40px;right:16px;'
    : 'position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; --mk-fg: #1f2328; --mk-bg: #ffffff; --mk-edge: #1f2328; --mk-muted: #57606a; --mk-soft: #eef1f4; --mk-accent: #6d28d9; --mk-accent-fg: #fff; }
    :host([data-mk-dark]) { --mk-fg: #f6f8fa; --mk-bg: #16181c; --mk-edge: #f6f8fa; --mk-muted: #9198a1; --mk-soft: #2a2e35; --mk-accent: #a78bfa; --mk-accent-fg: #16181c; }
    * { box-sizing: border-box; font: 13px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bar { display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 6px 0 4px; color: var(--mk-fg); background: var(--mk-bg);
      border: 1.5px solid var(--mk-edge); border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.25); max-width: calc(100vw - 16px); }
    .grip { cursor: grab; padding: 0 4px; color: var(--mk-muted); user-select: none; touch-action: none; font-size: 14px; }
    .grip:active { cursor: grabbing; }
    .tag { font-weight: 800; font-size: 10px; letter-spacing: .1em; color: var(--mk-accent); padding-right: 2px; }
    button { all: unset; box-sizing: border-box; cursor: pointer; color: inherit; border-radius: 999px; white-space: nowrap; }
    button:focus-visible { outline: 2px solid var(--mk-accent); outline-offset: 2px; }
    button[disabled] { opacity: .35; cursor: default; }
    .nav { height: 32px; padding: 0 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
    .back { border: 1.5px solid var(--mk-edge); }
    .back:not([disabled]):hover { background: var(--mk-soft); }
    .next { background: var(--mk-accent); color: var(--mk-accent-fg); border: 1.5px solid var(--mk-accent); }
    .next:not([disabled]):hover { filter: brightness(1.08); }
    .ico { height: 32px; min-width: 32px; padding: 0 8px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; color: var(--mk-fg); }
    .ico:hover { background: var(--mk-soft); }
    .fb { border: 1.5px solid var(--mk-muted); padding: 0 10px; font-weight: 600; }
    .where { display: flex; flex-direction: column; min-width: 0; padding: 0 6px; }
    .step { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
    .n { color: var(--mk-muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; display: flex; gap: 4px; min-width: 0; max-width: 260px; }
    .n .count { flex: none; }
    .trail { display: block; font-size: 11px; color: var(--mk-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .trail .on { color: var(--mk-accent); font-weight: 700; }
    .sep { width: 1px; height: 22px; background: var(--mk-muted); opacity: .4; margin: 0 2px; }
    .badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--mk-accent); color: var(--mk-accent-fg); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
    .submit { height: 32px; padding: 0 12px; font-weight: 700; border: 1.5px solid var(--mk-accent); color: var(--mk-accent); }
    .submit:hover { background: var(--mk-soft); }
    [hidden] { display: none !important; }
    .min .hide-min { display: none !important; }
    @media (max-width: 640px) { .trail, .restart-label, .nav .lbl, .fb-label { display: none; } .step { max-width: 30vw; } .nav { padding: 0 10px; } }
    .panel { position: absolute; left: 0; width: min(420px, calc(100vw - 16px)); max-height: 70vh; overflow: auto; background: var(--mk-bg); color: var(--mk-fg);
      border: 1.5px solid var(--mk-edge); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.3); padding: 10px; }
    .panel.down { top: 50px; } .panel.up { bottom: 50px; }
    .panel h4 { margin: 4px 2px 8px; font-weight: 700; font-size: 11px; color: var(--mk-muted); text-transform: uppercase; letter-spacing: .06em; }
    .row { display: flex; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 8px; align-items: baseline; }
    .row:hover { background: var(--mk-soft); } .row.on { background: var(--mk-soft); font-weight: 700; }
    .row .num { color: var(--mk-muted); width: 1.6em; flex: none; font-variant-numeric: tabular-nums; }
    .row.br { padding-left: 30px; } .row small { color: var(--mk-muted); margin-left: auto; padding-left: 12px; }
    .note { color: var(--mk-muted); margin: 0 2px 10px; white-space: pre-wrap; }
    textarea { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 76px; padding: 8px 10px; border: 1.5px solid var(--mk-muted); border-radius: 8px; white-space: pre-wrap; color: var(--mk-fg); }
    textarea:focus { border-color: var(--mk-accent); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .chip { padding: 3px 9px; border: 1.5px solid var(--mk-muted); border-radius: 999px; font-size: 12px; }
    .chip.on { border-color: var(--mk-accent); color: var(--mk-accent); font-weight: 700; }
    .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .actions .save { margin-left: auto; height: 32px; padding: 0 16px; font-weight: 700; background: var(--mk-accent); color: var(--mk-accent-fg); }
    .attach { height: 32px; padding: 0 10px; border: 1.5px dashed var(--mk-muted); }
    .thumb { max-width: 100%; max-height: 140px; border-radius: 6px; border: 1px solid var(--mk-muted); display: block; margin-top: 8px; }
    .item { border-top: 1px solid var(--mk-soft); padding: 8px 2px; }
    .item .meta { color: var(--mk-muted); font-size: 11px; display: flex; gap: 8px; align-items: center; }
    .item .del { margin-left: auto; color: var(--mk-muted); padding: 2px 6px; }
    .msg { padding: 8px; border-radius: 8px; background: var(--mk-soft); margin-top: 8px; }
  </style>
  <div class="bar" role="toolbar" aria-label="Mock journey">
    <span class="grip hide-min" title="Drag">⋮⋮</span><span class="tag">MOCK</span>
    <button class="ico restart hide-min" title="Restart the mock from the first screen" aria-label="Restart">⟲<span class="restart-label">Restart</span></button>
    <button class="nav back hide-min" title="Previous screen (←)" aria-label="Back">‹ <span class="lbl">Back</span></button>
    <div class="where"><span class="step"></span><span class="n"></span></div>
    <button class="nav next hide-min" title="Next screen (→)" aria-label="Next"><span class="lbl">Next</span> ›</button>
    <span class="sep hide-min"></span>
    <button class="ico steps hide-min" title="All screens" aria-label="All screens">☰</button>
    <button class="ico fb" title="Feedback on this screen" aria-label="Feedback">💬<span class="lbl fb-label">Feedback</span><span class="badge fb-count" hidden></span></button>
    <button class="submit hide-min" hidden title="Send all saved feedback to the session that builds this mock">Submit <span class="submit-n"></span></button>
    <button class="ico min-btn" title="Minimise" aria-label="Minimise">–</button>
  </div>
  <div class="panel down" hidden></div>`;
  document.body.append(host);

  const $ = (s) => root.querySelector(s);
  const bar = $('.bar'), panel = $('.panel');
  let open = '';
  let draft = { text: '', decision: '', image: '' };
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── contrast: the bar takes the opposite of the screen behind it ──
  const lum = (c) => {
    const m = c.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[, /]+([\d.]+))?/);
    if (!m || (m[4] !== undefined && +m[4] === 0)) return null;
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const screenIsDark = () => {
    const r = host.getBoundingClientRect();
    const was = host.style.visibility; host.style.visibility = 'hidden';
    let el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    host.style.visibility = was;
    for (; el; el = el.parentElement) { const l = lum(getComputedStyle(el).backgroundColor); if (l !== null) return l < 0.4; }
    return document.documentElement.classList.contains('dark');
  };
  // An attribute, never a class: a page rule like `.dark { --accent: … }` (Flowpad's own tokens) would match the
  // host element and override the bar's colours from outside its shadow root.
  const contrast = () => host.toggleAttribute('data-mk-dark', !screenIsDark());
  new MutationObserver(() => requestAnimationFrame(contrast)).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // ── rendering ──
  const multiApp = () => new Set(J.map((s) => s.app)).size > 1;
  function crumbs() {
    const out = [];
    J.forEach((s, i) => { if (isBranch(s)) return; const last = out[out.length - 1]; if (!last || last.app !== s.app) out.push({ app: s.app, from: i }); });
    return out;
  }
  function render() {
    if (!J.length) { $('.step').textContent = data.error || 'Loading the mock…'; $('.n').textContent = ''; return; }
    const s = J[cur];
    $('.step').textContent = (isBranch(s) ? '↳ ' : '') + s.title;
    const multi = multiApp();
    let on = -1; const cs = crumbs();
    cs.forEach((c, k) => { if (c.from <= cur && (!isBranch(s) || c.app === s.app)) on = k; });
    $('.n').innerHTML = (multi ? `<span class="trail">${cs.map((c, k) => `<span class="${k === on ? 'on' : ''}">${esc(c.app)}</span>`).join(' ▸ ')}</span><span class="count">·</span>` : '')
      + `<span class="count">${cur + 1} of ${J.length}</span>`;
    $('.back').disabled = cur === 0;
    $('.next').disabled = mainAfter(cur) === cur;
    const nOpen = openRows().length;
    $('.fb-count').hidden = !nOpen; $('.fb-count').textContent = nOpen;
    $('.submit').hidden = !nOpen; $('.submit-n').textContent = `(${nOpen})`;
    if (open) renderPanel();
  }

  function placePanel() {
    const r = host.getBoundingClientRect();
    panel.className = 'panel ' + (r.top > innerHeight / 2 ? 'up' : 'down');
    panel.style.cssText = r.left + 420 > innerWidth ? 'left:auto;right:0' : '';
  }
  function renderPanel() {
    panel.hidden = !open;
    if (!open) return;
    placePanel();
    if (open === 'steps') {
      let n = 0;
      const multi = multiApp();
      panel.innerHTML = '<h4>Screens</h4>' + J.map((s, i) => {
        const label = isBranch(s) ? `↳ ${esc(s.when || s.title)}${s.when ? ` — ${esc(s.title)}` : ''}` : esc(s.title);
        const num = isBranch(s) ? '' : String(++n);
        return `<button class="row${isBranch(s) ? ' br' : ''}${i === cur ? ' on' : ''}" data-i="${i}"><span class="num">${num}</span>${label}${multi ? `<small>${esc(s.app)}</small>` : ''}</button>`;
      }).join('');
      return;
    }
    // feedback
    const s = J[cur] || {};
    const decisions = s.decisions || [];
    let html = `<h4>Feedback · ${esc(s.title || '')}</h4>`;
    if (s.note) html += `<div class="note">${esc(s.note)}</div>`;
    if (!data.fbDs) {
      html += `<div class="msg">${esc(data.error || 'Loading…')}</div>`;
      panel.innerHTML = html; return;
    }
    if (decisions.length) {
      html += `<div class="chips">${decisions.map((d) => `<button class="chip${draft.decision === d.id ? ' on' : ''}" data-dec="${esc(d.id)}" title="${esc(d.question)}">${esc(d.id)} · ${esc(d.question.length > 40 ? d.question.slice(0, 40) + '…' : d.question)}</button>`).join('')}</div>`;
    }
    html += `<textarea placeholder="What should change on this screen? (paste an image here too)"></textarea>`
      + (draft.image ? `<img class="thumb" src="${draft.image}" alt="attached image">` : '')
      + `<div class="actions"><button class="attach">📎 ${draft.image ? 'Replace image' : 'Attach image'}</button>`
      + (draft.image ? '<button class="ico clear-img" title="Remove the image">✕</button>' : '')
      + `<button class="save">Save</button></div><input class="file" type="file" accept="image/*" hidden>`;
    const here = stepRows();
    if (here.length) {
      html += `<h4 style="margin-top:14px">Saved on this screen (${here.length})</h4>` + here.map((r) => {
        const i = r.input;
        return `<div class="item"><div class="meta">${i.decision ? `<b>${esc(i.decision)}</b>` : ''}<span>${esc(i.status)}</span><span>${esc((i.created || '').slice(11, 16))}</span>`
          + (i.status === 'open' ? `<button class="del" data-key="${esc(r.key)}" data-v="${esc(r.version || '')}" title="Delete">✕</button>` : '') + `</div>`
          + `<div>${esc(i.text)}</div>${i.screenshot ? `<img class="thumb" src="${i.screenshot}" alt="">` : ''}</div>`;
      }).join('');
    }
    panel.innerHTML = html;
    const ta = $('textarea');
    ta.value = draft.text;
    ta.addEventListener('input', () => { draft.text = ta.value; });
    ta.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); readImage(file); }
    });
    ta.focus();
  }

  const readImage = (file) => {
    const fr = new FileReader();
    fr.onload = () => { draft.image = String(fr.result); renderPanel(); };
    fr.readAsDataURL(file);
  };

  // ── data: the mock row and its feedback rows, through the Flowpad SDK ──
  async function boot() {
    let sdk;
    try { sdk = await import('/sdk/flowpad-sdk.js'); } catch { sdk = null; }
    if (!sdk || !CFG.key) {
      data.error = CFG.key ? 'Feedback needs this mock served by Flowpad (`flow app serve`).' : 'No MOCKIFY.key on this page — feedback is off.';
      return finishBoot();
    }
    try {
      await sdk.initSdk();
      let projectId = null;
      try { const { app } = await sdk.resolveAppHost(); projectId = app?.project_id || null; } catch { /* not an app endpoint */ }
      projectId = projectId || sdk.dataContext?.projectTypeId?.id || null;
      const [[mocksDs], [fbDs]] = await Promise.all(['mockify.mock', 'mockify.feedback']
        .map((kind) => sdk.Dataset.forKind(kind, projectId || undefined)));
      if (!mocksDs || !fbDs) throw new Error('this project has no mocks / mock-feedback dataset (mockify scripts/install_data.py)');
      Object.assign(data, { sdk, mocksDs, fbDs });
      await loadMock();
      await refresh();
      mocksDs.onRowsChanged(() => loadMock().then(render));
      fbDs.onRowsChanged(() => refresh());
    } catch (err) {
      data.error = `Feedback is off: ${err?.message || err}`;
      data.fbDs = null;
    }
    finishBoot();
  }
  async function loadMock() {
    const found = await data.mocksDs.rows({ match: { key: CFG.key } });
    const row = found.rows[0];
    if (!row) throw new Error(`no mock row "${CFG.key}" in the mocks dataset`);
    data.mock = row;
    J = row.input.journey || [];
  }
  // The mock's comments, once: the badge counts the open ones, the panel shows this screen's. Calls that
  // overlap (a save, then the change event it causes) collapse into one fetch plus at most one more.
  let inflight = null, again = false;
  async function refresh() {
    if (!data.fbDs || !data.mock) return;
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      do {
        again = false;
        const found = await data.fbDs.rows({ match: { 'input.mock': data.mock.ref }, order_by: { 'input.created': 'asc' } });
        data.rows = found.rows;
      } while (again);
      inflight = null;
      render();
    })();
    return inflight;
  }
  function finishBoot() {
    cur = Math.max(0, find(location.hash.slice(1)));
    if (typeof window.mockGo !== 'function' && J.length) show(J[cur].id);
    render();
    requestAnimationFrame(contrast);
  }

  async function saveFeedback() {
    const s = J[cur];
    const text = draft.text.trim();
    if (!text && !draft.image) return;
    const input = { mock: data.mock.ref, step: s.id, text: text || '(image)', status: 'open', created: new Date().toISOString() };
    if (draft.decision) input.decision = draft.decision;
    if (draft.image) input.screenshot = draft.image;
    const key = `${CFG.key}-${s.id}-${Date.now().toString(36)}`;
    $('.save').disabled = true;
    try {
      await data.fbDs.append([{ key, input }]);
      draft = { text: '', decision: '', image: '' };
      await refresh();
    } catch (err) {
      panel.insertAdjacentHTML('beforeend', `<div class="msg">Not saved: ${esc(err?.message || err)}</div>`);
      $('.save').disabled = false;
    }
  }

  async function submitAll() {
    const rows = openRows();
    if (!rows.length || !data.mock) return;
    const btn = $('.submit'); btn.disabled = true;
    try {
      await data.fbDs.putMany(rows.map((r) => ({ key: r.key, input: { ...r.input, status: 'submitted' } })),
        { expected: Object.fromEntries(rows.map((r) => [r.key, r.version])) });
      const m = data.mock;
      await data.mocksDs.put(CFG.key, { input: { ...m.input, status: 'submitted' } }, { expected: m.version });
      const byStep = {};
      rows.forEach((r) => (byStep[r.input.step] ||= []).push(r.input));
      const lines = J.filter((s) => byStep[s.id]).map((s) => `- ${s.id} (${s.title}): ` + byStep[s.id]
        .map((i) => `${i.decision ? i.decision + ': ' : ''}${i.text.slice(0, 120)}${i.screenshot ? ' [image]' : ''}`).join(' | '));
      const prompt = `Feedback submitted on mock "${CFG.key}" — ${rows.length} comment(s) on ${Object.keys(byStep).length} screen(s).\n`
        + `Read them as typed rows (mockify skill, "Reading feedback"): the mock-feedback dataset, match input.mock = ${m.ref} and input.status = submitted.\n`
        + lines.join('\n');
      if (m.input.session) {
        const proc = await data.sdk.dataManager.getByTypeId(new data.sdk.TypeId('agentic_process', m.input.session));
        if (!proc) throw new Error(`session ${m.input.session} not found`);
        await proc.enqueue(prompt, 'mockify');
      }
      open = 'feedback';
      await Promise.all([refresh(), loadMock()]);
      panel.innerHTML = `<h4>Submitted</h4><div class="msg">${rows.length} comment(s) sent${m.input.session ? ' to the session that builds this mock' : ' — no session on the mock row, so nothing was sent; they are saved as submitted'}.</div>`;
      placePanel(); panel.hidden = false;
    } catch (err) {
      open = 'feedback'; renderPanel();
      panel.insertAdjacentHTML('beforeend', `<div class="msg">Not submitted: ${esc(err?.message || err)}</div>`);
    } finally { btn.disabled = false; }
  }

  // ── controls ──
  $('.back').onclick = () => go(mainBefore(cur));
  $('.next').onclick = () => go(mainAfter(cur));
  $('.restart').onclick = () => { open = ''; renderPanel(); go(0); };
  $('.steps').onclick = () => { open = open === 'steps' ? '' : 'steps'; renderPanel(); };
  $('.fb').onclick = () => { open = open === 'feedback' ? '' : 'feedback'; renderPanel(); };
  $('.submit').onclick = submitAll;
  const minLabel = () => { const m = bar.classList.contains('min'), b = $('.min-btn'); b.textContent = m ? '+' : '–'; b.title = m ? 'Restore' : 'Minimise'; b.setAttribute('aria-label', b.title); };
  if (store.get('min')) bar.classList.add('min');
  minLabel();
  $('.min-btn').onclick = () => {
    bar.classList.toggle('min'); open = ''; renderPanel(); store.set('min', bar.classList.contains('min')); minLabel();
    reclamp();
  };
  panel.addEventListener('click', (e) => {
    const t = e.target;
    const row = t.closest('[data-i]');
    if (row) { open = ''; renderPanel(); go(+row.dataset.i); return; }
    const chip = t.closest('[data-dec]');
    if (chip) { draft.decision = draft.decision === chip.dataset.dec ? '' : chip.dataset.dec; renderPanel(); return; }
    if (t.closest('.attach')) { $('.file').click(); return; }
    if (t.closest('.clear-img')) { draft.image = ''; renderPanel(); return; }
    if (t.closest('.save')) { saveFeedback(); return; }
    const del = t.closest('.del');
    if (del) { data.fbDs.deleteRow(del.dataset.key, del.dataset.v ? { expected: del.dataset.v } : {}).then(refresh); }
  });
  panel.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) readImage(f); });

  // Drag by the grip; the position survives reloads (real-mode mocks reload per step) and stays on screen.
  $('.grip').addEventListener('pointerdown', (e) => {
    const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    e.target.setPointerCapture(e.pointerId);
    const move = (m) => place(m.clientX - dx, m.clientY - dy);
    e.target.addEventListener('pointermove', move);
    e.target.addEventListener('pointerup', () => {
      e.target.removeEventListener('pointermove', move);
      const b = host.getBoundingClientRect(); store.set('pos', { x: b.left, y: b.top }); contrast();
    }, { once: true });
  });
  const pos = store.get('pos');
  if (pos) requestAnimationFrame(() => place(pos.x, pos.y));
  addEventListener('resize', () => { reclamp(); contrast(); });

  addEventListener('keydown', (e) => {
    const t = e.composedPath()[0];
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (e.key === 'ArrowRight' && !$('.next').disabled) $('.next').click();
    if (e.key === 'ArrowLeft' && !$('.back').disabled) $('.back').click();
  });
  const fromHash = () => { const i = find(location.hash.slice(1)); if (i >= 0 && i !== cur) go(i, false); };
  addEventListener('hashchange', fromHash);
  addEventListener('popstate', fromHash);

  window.mockifyGo = (id) => { const i = find(id); if (i >= 0) go(i); else console.warn(`mockify: no step "${id}" in the journey`); };
  render();
  boot();
  addEventListener('load', contrast);
})();
