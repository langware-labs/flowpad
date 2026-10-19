/* mockify journey bar v2 — paste inline as the LAST script in every mock's <body>. Self-contained.
 * Contract (what the page defines, the data it reads and writes, the controls): journey-bar.md. */
(() => {
  const CFG = window.MOCKIFY || {};
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem('mockify:' + k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem('mockify:' + k, JSON.stringify(v)); } catch { /* no storage here */ } },
  };
  const docStyle = document.createElement('style');
  // Hints mark the mock's OWN controls, so they live in the page: a soft accent glow on the control that
  // leads to the expected next screen, a faint dashed ring on any other control that moves the journey.
  // box-shadow, not outline: a screen's own outlines (an open decision) stay as they are.
  docStyle.textContent = `[data-step][hidden]{display:none!important}
    .mk-next{box-shadow:0 0 0 3px color-mix(in srgb,var(--mk-hint,#8b5cf6) 45%,transparent),0 0 14px 2px color-mix(in srgb,var(--mk-hint,#8b5cf6) 35%,transparent)!important;border-radius:6px;animation:mk-glow 2.4s ease-in-out 3}
    .mk-path{box-shadow:0 0 0 1.5px color-mix(in srgb,var(--mk-hint,#8b5cf6) 35%,transparent)!important;border-radius:6px}
    @keyframes mk-glow{50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--mk-hint,#8b5cf6) 20%,transparent)}}
    @media (prefers-reduced-motion:reduce){.mk-next{animation:none}}
    .mk-pick{outline:2px solid #6d28d9!important;outline-offset:2px!important}
    html.mk-picking,html.mk-picking *{cursor:crosshair!important}`;
  document.head.append(docStyle);

  let J = CFG.journey || [];       // the steps (from the mock row once loaded): {id, app, title, note?, branch_of?, when?, decisions?[]}
  let cur = 0;
  const data = { sdk: null, mock: null, mocksDs: null, fbDs: null, rows: [], error: '' };
  const openRows = () => data.rows.filter((r) => r.input.status === 'open');
  const sentRows = () => data.rows.filter((r) => r.input.status !== 'open');
  const stepRows = () => data.rows.filter((r) => r.input.step === J[cur]?.id);

  const isBranch = (s) => !!s.branch_of;
  const find = (id) => J.findIndex((s) => s.id === id);   // -1 when there is no such step
  const mainAfter = (i) => { for (let k = i + 1; k < J.length; k++) if (!isBranch(J[k])) return k; return i; };
  // Where a screen goes on: its own `next` (a branch's Try again, a screen that always takes a branch), else
  // the next main-path screen. Next, its hint and the screen's glowing control all follow this one rule.
  const onwardOf = (i) => { const n = J[i]?.next ? find(J[i].next) : -1; return n >= 0 ? n : mainAfter(i); };
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
    justSaved = '';   // a new screen starts with the box out
    show(id);
    render();
    contrast();
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
    .scope { color: var(--mk-accent); }
    .scope.on { background: var(--mk-accent); color: var(--mk-accent-fg); }
    .anchor { display: flex; gap: 8px; align-items: center; margin: 6px 0 8px; padding: 6px 8px; border-radius: 8px; background: var(--mk-soft); }
    .anchor b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item.on { outline: 2px solid var(--mk-accent); border-radius: 8px; }
    button { all: unset; box-sizing: border-box; cursor: pointer; color: inherit; border-radius: 999px; white-space: nowrap; }
    button:focus-visible { outline: 2px solid var(--mk-accent); outline-offset: 2px; }
    button[disabled] { opacity: .35; cursor: default; }
    .nav { height: 32px; padding: 0 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
    .back { border: 1.5px solid var(--mk-edge); }
    .back:not([disabled]):hover { background: var(--mk-soft); }
    .next { background: var(--mk-accent); color: var(--mk-accent-fg); border: 1.5px solid var(--mk-accent); }
    .next:not([disabled]):hover { filter: brightness(1.08); }
    .next.hint { animation: mk-pulse 2.4s ease-in-out 3; box-shadow: 0 0 0 3px color-mix(in srgb, var(--mk-accent) 30%, transparent); }
    @keyframes mk-pulse { 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--mk-accent) 30%, transparent); } }
    @media (prefers-reduced-motion: reduce) { .next.hint { animation: none; } }
    .ico { height: 32px; min-width: 32px; padding: 0 8px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; color: var(--mk-fg); }
    .ico:hover { background: var(--mk-soft); }
    .where { display: flex; flex-direction: column; min-width: 0; padding: 0 6px; }
    .step { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
    .n { color: var(--mk-muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; display: flex; gap: 4px; min-width: 0; max-width: 260px; }
    .n .count { flex: none; }
    .trail { display: block; font-size: 11px; color: var(--mk-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .trail .on { color: var(--mk-accent); font-weight: 700; }
    .sep { width: 1px; height: 22px; background: var(--mk-muted); opacity: .4; margin: 0 2px; }
    .badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--mk-accent); color: var(--mk-accent-fg); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
    .execute { height: 32px; padding: 0 14px; font-weight: 700; border-radius: 999px; background: var(--mk-accent); color: var(--mk-accent-fg); }
    .execute:disabled { opacity: .45; cursor: default; }
    .ptools { display: flex; gap: 4px; margin: -2px 28px 8px 0; padding-bottom: 8px; border-bottom: 1px solid color-mix(in srgb, var(--mk-muted) 35%, transparent); }
    .ptools .tb.on { border-color: var(--mk-accent); color: var(--mk-accent); }
    [hidden] { display: none !important; }
    .min .hide-min { display: none !important; }
    @media (max-width: 900px) { .restart-label, .nav .lbl, .trail { display: none; } .step { max-width: 26vw; } .nav { padding: 0 10px; } }
    .panel { position: absolute; left: 0; width: min(420px, calc(100vw - 16px)); max-height: 70vh; overflow: auto; background: var(--mk-bg); color: var(--mk-fg);
      border: 1.5px solid var(--mk-edge); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.3); padding: 10px; }
    .panel.down { top: 50px; } .panel.up { bottom: 50px; }
    .panel.wide { width: min(680px, calc(100vw - 16px)); }
    .md { margin: 8px 0 0; padding: 10px 12px; max-height: 46vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--mk-soft); border-radius: 8px; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .tb { height: 30px; padding: 0 12px; border: 1.5px solid var(--mk-muted); font-weight: 600; }
    .tb:hover { background: var(--mk-soft); }
    .toolbar .send { margin-left: auto; height: 32px; padding: 0 16px; font-weight: 700; background: var(--mk-accent); color: var(--mk-accent-fg); }
    .panel .close { position: absolute; top: 6px; right: 6px; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 999px; color: var(--mk-muted); font-size: 14px; }
    .panel .close:hover { background: var(--mk-soft); color: var(--mk-fg); }
    .panel h4:first-of-type { padding-right: 28px; }
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
    <span class="grip hide-min" title="Drag">⋮⋮</span><button class="ico scope" title="Point at an element to comment on it (Esc cancels)" aria-label="Comment on an element"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"/><path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h2"/><path d="M14 3h1"/><path d="M3 9v1"/><path d="M21 9v2"/><path d="M3 14v1"/></svg></button>
    <button class="ico restart hide-min" title="Restart the mock from the first screen" aria-label="Restart">⟲<span class="restart-label">Restart</span></button>
    <button class="nav back hide-min" title="Previous screen (←)" aria-label="Back">‹ <span class="lbl">Back</span></button>
    <div class="where"><span class="step"></span><span class="n"></span></div>
    <button class="nav next hide-min" title="Next screen (→)" aria-label="Next"><span class="lbl">Next</span> ›</button>
    <span class="sep hide-min"></span>
    <button class="ico steps hide-min" title="All screens" aria-label="All screens">☰</button>
    <button class="execute" title="Send the comments so far to the session that builds this mock">▶ Execute <span class="exec-n"></span></button>
    <button class="ico min-btn" title="Minimise" aria-label="Minimise">–</button>
  </div>
  <div class="panel down" hidden></div>`;
  document.body.append(host);

  const $ = (s) => root.querySelector(s);
  const bar = $('.bar'), panel = $('.panel');

  // ── next-step hints: which controls on this screen move the journey, and which one goes onward ──
  // A control names where it leads with data-next="<step id>"; the one leading onward glows, the rest ring.
  let hints = store.get('hints') !== false;
  let marked = [], hintKey = '';
  const warned = new Set();
  function markHints(force = false) {
    const key = `${cur}|${hints}|${J.length}`;
    if (!force && key === hintKey) return;
    hintKey = key;
    marked.forEach((el) => el.classList.remove('mk-next', 'mk-path'));
    marked = [];
    $('.next').classList.remove('hint');
    if (!hints || !J.length) return;
    const screen = document.querySelector(`[data-step="${CSS.escape(J[cur].id)}"]`) || document.body;
    const o = onwardOf(cur), onward = o !== cur ? J[o].id : null;
    screen.querySelectorAll('[data-next]').forEach((el) => {
      if (el.closest('[hidden], [data-mockify]')) return;
      const to = el.dataset.next;
      if (find(to) < 0) { if (!warned.has(to)) { warned.add(to); console.warn(`mockify: data-next="${to}" names no step`); } return; }
      el.classList.add(to === onward ? 'mk-next' : 'mk-path');
      marked.push(el);
    });
    if (onward && !marked.some((el) => el.classList.contains('mk-next'))) $('.next').classList.add('hint');
  }
  // data-next works on its own: a click on such a control moves the journey (no onclick needed).
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-next]');
    if (el && !el.closest('[data-mockify]')) { e.preventDefault(); window.mockifyGo(el.dataset.next); }
  });
  let open = '';
  let panelKey = '';   // what the open panel last drew: re-drawn only when this changes
  const panelState = () => open === 'feedback'
    ? `f|${cur}|${!!data.fbDs}|${stepRows().map((r) => r.key + r.version).join()}`
    : open === 'save' ? `v|${data.mock?.version}` : open === 'send' ? `s|${data.rows.map((r) => r.key + r.version).join()}` : `${open}|${cur}|${J.length}`;
  const setPanel = (p) => { open = p; renderPanel(); };
  const NO_DRAFT = { text: '', decision: '', image: '', anchor: null, shot: '' };
  let draft = { ...NO_DRAFT };
  let justSaved = '';   // after a Save: the box folds away and the saved entry shows, until a new comment
  const composing = () => !justSaved;
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
  const contrastNow = () => {
    const dark = screenIsDark();
    host.toggleAttribute('data-mk-dark', !dark);
    document.documentElement.style.setProperty('--mk-hint', dark ? '#a78bfa' : '#6d28d9');   // = the bar's --mk-accent
  };
  let contrastQueued = false;   // one check per frame, whoever asks (a step, a drag, a resize, a theme flip)
  const contrast = () => { if (contrastQueued) return; contrastQueued = true; requestAnimationFrame(() => { contrastQueued = false; contrastNow(); }); };
  new MutationObserver(contrast).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

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
    const trail = cs.map((c, k) => (k === on ? `<span class="on">${esc(c.app)}</span>` : esc(c.app))).join(' ▸ ');
    $('.n').innerHTML = (multi ? `<span class="trail">${trail}</span><span class="count">·</span>` : '')
      + `<span class="count">${cur + 1} of ${J.length}</span>`;
    $('.back').disabled = cur === 0;
    $('.next').disabled = onwardOf(cur) === cur;
    const nOpen = openRows().length;
    $('.exec-n').textContent = nOpen ? `(${nOpen})` : '';
    $('.execute').disabled = !nOpen || !data.mock?.input.session;
    if (open && panelState() !== panelKey) renderPanel();
    markHints();
    drawPins();
  }

  function placePanel() {
    const r = host.getBoundingClientRect();
    panel.className = 'panel ' + (r.top > innerHeight / 2 ? 'up' : 'down');
    panel.style.cssText = r.left + 420 > innerWidth ? 'left:auto;right:0' : '';
  }
  // Every panel opens with the same toolbar: the screen's feedback, the review of what is sent, saving to the repo.
  const TOOLS = [['feedback', '💬 Feedback'], ['send', 'Review'], ['save', '💾 Save to repo']];
  const head = () => '<button class="close" title="Close (Esc)" aria-label="Close">✕</button><div class="ptools">'
    + TOOLS.map(([p, l]) => `<button class="tb ptool${open === p ? ' on' : ''}" data-panel="${p}">${l}</button>`).join('') + '</div>';
  function renderPanel() {
    panel.hidden = !open;
    panelKey = panelState();
    if (!open) return;
    placePanel();
    if (open === 'steps') {
      let n = 0;
      const multi = multiApp();
      panel.innerHTML = head() + '<h4>Screens</h4>' + J.map((s, i) => {
        const label = (isBranch(s) ? '↳ ' : '') + esc(isBranch(s) && s.when ? `${s.when} — ${s.title}` : s.title);
        const num = isBranch(s) ? '' : String(++n);
        return `<button class="row${isBranch(s) ? ' br' : ''}${i === cur ? ' on' : ''}" data-i="${i}"><span class="num">${num}</span>${label}${multi ? `<small>${esc(s.app)}</small>` : ''}</button>`;
      }).join('') + `<button class="row hints-toggle" style="margin-top:6px">${hints ? '☑' : '☐'} Highlight the next step on each screen</button>`;
      return;
    }
    if (open === 'save') {
      panel.classList.add('wide');
      const repo = data.mock?.input.repo || '', session = data.mock?.input.session || '';
      const dest = repo ? `${repo}/agentic-assets/webapp/mock-${CFG.key}` : '';
      if (session && target.id !== session) sessionOf().then(() => open === 'save' && renderPanel());
      panel.innerHTML = head() + `<h4>Save to repo</h4>`
        + `<div class="note">Until now this mock lives outside the repo (a temp mock project). Saving copies it into the repo as one self-contained folder: the page, its assets, the journey and <code>mock.json</code>. Feedback stays out.</div>`
        + (dest ? `<pre class="md">${esc(dest)}/</pre>` : `<div class="msg">The mock row names no repo — nothing to save into.</div>`)
        + `<div class="toolbar" style="margin-top:8px"><button class="send save-now"${dest && session ? '' : ' disabled'}>${session ? `Ask ${esc(target.name || '…')} to save it ▶` : 'No session to save it'}</button></div>`;
      return;
    }
    if (open === 'send') {
      if (data.mock?.input.session && target.id !== data.mock.input.session) sessionOf().then(() => open === 'send' && renderPanel());
      panel.classList.add('wide');
      const unsent = openRows(), sent = sentRows();
      const folder = data.mock?.input.folder || CFG.folder || '';
      const tools = (which) => `<div class="toolbar"><button class="tb open-folder"${folder ? '' : ' disabled title="The mock row has no folder"'}>📁 Open folder</button>`
        + `<button class="tb copy-md" data-which="${which}">⧉ Copy</button>`
        + (!data.mock?.input.session ? `<button class="send" disabled title="The mock row names no session to send to">No session to send to</button>`
          : which === 'unsent' ? `<button class="send send-now" title="session ${esc(data.mock.input.session)}">Send to ${esc(target.name || '…')} ▶</button>`
          : `<button class="send send-again" title="session ${esc(data.mock.input.session)}">Send again to ${esc(target.name || '…')} ▶</button>`) + `</div>`;
      let html = head();
      if (unsent.length) {
        html += `<h4>Review &amp; send · ${unsent.length} new comment(s)</h4><div class="note">The session receives this as a file in its input folder, with a one-line note pointing at it.</div>`
          + tools('unsent') + `<pre class="md">${esc(feedbackMarkdown(unsent))}</pre>`;
      } else {
        html += `<h4>Review</h4><div class="note">No new comments to send — leave one with 💬 Feedback or the picker.</div>`;
      }
      if (sent.length) {
        html += `<h4 style="margin-top:14px">Already sent · ${sent.length} comment(s)</h4>` + (unsent.length ? '' : tools('sent'))
          + `<pre class="md">${esc(feedbackMarkdown(sent))}</pre>`;
      }
      panel.innerHTML = html;
      return;
    }
    panel.classList.remove('wide');
    // feedback
    const s = J[cur] || {};
    const decisions = s.decisions || [];
    let html = head() + `<h4>Feedback · ${esc(s.title || '')}</h4>`;
    if (s.note) html += `<div class="note">${esc(s.note)}</div>`;
    if (!data.fbDs) {
      html += `<div class="msg">${esc(data.error || 'Loading…')}</div>`;
      panel.innerHTML = html; return;
    }
    if (composing() && decisions.length) {
      html += `<div class="chips">${decisions.map((d) => `<button class="chip${draft.decision === d.id ? ' on' : ''}" data-dec="${esc(d.id)}" title="${esc(d.question)}">${esc(d.id)} · ${esc(d.question.length > 40 ? d.question.slice(0, 40) + '…' : d.question)}</button>`).join('')}</div>`;
    }
    if (composing() && draft.anchor) {
      html += `<div class="anchor">📍 <span>On</span> <b title="${esc(draft.anchor.selector)}">${esc(draft.anchor.label)}</b><button class="ico clear-anchor" title="Not on this element">✕</button></div>`
        + (draft.shot ? `<img class="thumb" src="${draft.shot}" alt="the element">` : '');
    }
    if (!composing()) html += `<div class="actions"><button class="tb review-all">Review all feedback</button><button class="save new-comment">＋ New comment</button></div>`;
    else html += `<textarea placeholder="${draft.anchor ? 'What do you want for this element?' : 'What should change on this screen? (or use the picker at the left of the bar to point at an element)'}"></textarea>`
      + (draft.image ? `<img class="thumb" src="${draft.image}" alt="attached image">` : '')
      + `<div class="actions"><button class="attach">📎 ${draft.image ? 'Replace image' : 'Attach image'}</button>`
      + (draft.image ? '<button class="ico clear-img" title="Remove the image">✕</button>' : '')
      + `<button class="save">Save</button></div><input class="file" type="file" accept="image/*" hidden>`;
    const here = stepRows();
    if (here.length) {
      html += `<h4 style="margin-top:14px">Saved on this screen (${here.length})</h4>` + here.map((r) => {
        const i = r.input;
        return `<div class="item${r.key === justSaved ? ' on' : ''}" data-key="${esc(r.key)}"><div class="meta">${i.anchor ? `<b>📍 ${esc(i.anchor.label)}</b>` : ''}${i.decision ? `<b>${esc(i.decision)}</b>` : ''}<span>${esc(i.status)}</span><span>${esc((i.created || '').slice(11, 16))}</span>`
          + (i.status === 'open' ? `<button class="del" data-key="${esc(r.key)}" data-v="${esc(r.version || '')}" title="Delete">✕</button>` : '') + `</div>`
          + `<div>${esc(i.text)}</div>${i.element_shot ? `<img class="thumb" src="${i.element_shot}" alt="the element">` : ''}${i.screenshot ? `<img class="thumb" src="${i.screenshot}" alt="">` : ''}</div>`;
      }).join('');
    }
    panel.innerHTML = html;
    if (justSaved) root.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' });
    const ta = $('textarea');
    if (!ta) return;
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

  // ── 🎯 point at an element: the comment is saved with where it is, and a bubble marks it ──
  const isOurs = (el) => !!el.closest?.('[data-mockify], [data-mockify-pins]');
  let picking = false, hovered = null;
  const unhover = () => { hovered?.classList.remove('mk-pick'); hovered = null; };
  const setPicking = (on) => {
    picking = on;
    document.documentElement.classList.toggle('mk-picking', on);
    $('.scope').classList.toggle('on', on);
    if (!on) unhover();
  };
  document.addEventListener('mouseover', (e) => {
    if (!picking || isOurs(e.target)) return;
    unhover(); hovered = e.target; hovered.classList.add('mk-pick');
  }, true);
  // Capture phase: while picking, a click points — it never presses the mock's own control.
  document.addEventListener('click', (e) => {
    if (!picking || isOurs(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    setPicking(false);
    draft.anchor = anchorOf(el); draft.shot = '';
    justSaved = '';
    setPanel('feedback');
    snapshot(el).then((png) => { if (png && draft.anchor) { draft.shot = png; renderPanel(); } });
  }, true);

  // A selector that finds the element again: from the nearest id or the screen's [data-step] section down.
  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      if (e.dataset.step) { parts.unshift(`[data-step="${CSS.escape(e.dataset.step)}"]`); break; }
      let n = 1;
      for (let sib = e.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === e.tagName) n++;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${n})`);
    }
    return parts.join(' > ');
  }
  function anchorOf(el) {
    const r = el.getBoundingClientRect();
    const said = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || '';
    return {
      selector: cssPath(el),
      label: said.trim().replace(/\s+/g, ' ').slice(0, 60) || `<${el.tagName.toLowerCase()}>`,
      html: el.outerHTML.slice(0, 1500),
      x: r.right + scrollX, y: r.top + scrollY, w: r.width, h: r.height,
    };
  }
  // The element as it looks, best effort: its subtree with computed styles inlined, drawn through an SVG
  // <foreignObject> onto a canvas. Big subtrees, cross-origin images (a tainted canvas) give no picture.
  async function snapshot(el) {
    try {
      const r = el.getBoundingClientRect();
      const w = Math.ceil(Math.min(r.width, 1200)), h = Math.ceil(Math.min(r.height, 900));
      const src = [el, ...el.querySelectorAll('*')];
      if (w < 4 || h < 4 || src.length > 400) return '';
      const copy = el.cloneNode(true);
      const dst = [copy, ...copy.querySelectorAll('*')];
      src.forEach((node, k) => {
        const cs = getComputedStyle(node);
        dst[k].setAttribute('style', Array.from(cs, (prop) => `${prop}:${cs.getPropertyValue(prop)}`).join(';'));
        dst[k].classList?.remove('mk-pick', 'mk-next', 'mk-path');
      });
      let bg = 'transparent';
      for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (lum(c) !== null) { bg = c; break; } }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" style="background:${bg};width:${w}px;height:${h}px;overflow:hidden">`
        + `${new XMLSerializer().serializeToString(copy)}</div></foreignObject></svg>`;
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      const scale = Math.min(2, devicePixelRatio || 1);
      const canvas = Object.assign(document.createElement('canvas'), { width: w * scale, height: h * scale });
      const g = canvas.getContext('2d');
      g.scale(scale, scale); g.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch { return ''; }
  }

  // Bubbles: one per pointed-at comment on this screen, at its element (or where the element was).
  const pins = document.createElement('div');
  pins.setAttribute('data-mockify-pins', '');
  pins.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;';
  document.body.append(pins);
  const pinRoot = pins.attachShadow({ mode: 'open' });
  pinRoot.innerHTML = `<style>
    .pin { all: unset; position: absolute; transform: translate(-40%, -60%); width: 24px; height: 24px; display: grid; place-items: center;
      border-radius: 50% 50% 50% 4px; background: #6d28d9; color: #fff; font: 700 11px ui-sans-serif, system-ui, sans-serif;
      border: 2px solid #fff; box-shadow: 0 2px 8px rgba(0,0,0,.35); cursor: pointer; }
    .pin:hover { transform: translate(-40%, -60%) scale(1.12); }
    .pin.done { background: #6e7681; }
  </style><div class="layer"></div>`;
  function drawPins() {
    const layer = pinRoot.querySelector('.layer');
    layer.replaceChildren();
    stepRows().filter((r) => r.input.anchor).forEach((r, k) => {
      const a = r.input.anchor;
      let x = a.x, y = a.y;
      try {
        const el = document.querySelector(a.selector);
        if (el && !el.closest('[hidden]')) { const b = el.getBoundingClientRect(); x = b.right + scrollX; y = b.top + scrollY; }
      } catch { /* a selector that no longer parses: the stored spot stands */ }
      const pin = Object.assign(document.createElement('button'), { className: `pin${r.input.status === 'open' ? '' : ' done'}`, textContent: String(k + 1) });
      pin.title = `${a.label}: ${r.input.text}`;
      pin.style.left = `${x}px`; pin.style.top = `${y}px`;
      pin.onclick = () => openComment(r);
      layer.append(pin);
    });
  }
  // A bubble opens its comment: the feedback panel on it, and its element outlined for a moment.
  function openComment(r) {
    setPanel('feedback');
    const item = root.querySelector(`.item[data-key="${CSS.escape(r.key)}"]`);
    item?.classList.add('on'); item?.scrollIntoView({ block: 'nearest' });
    try {
      const el = document.querySelector(r.input.anchor.selector);
      el?.classList.add('mk-pick'); setTimeout(() => el?.classList.remove('mk-pick'), 1600);
    } catch { /* no element: the comment still opens */ }
  }

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
      // The mock project (mock_project.py ensure) holds the datasets; the serving process may belong to the repo's.
      let projectId = CFG.project || null;
      if (!projectId) try { const { app } = await sdk.resolveAppHost(); projectId = app?.project_id || null; } catch { /* not an app endpoint */ }
      projectId = projectId || sdk.dataContext?.projectTypeId?.id || null;
      const [[mocksDs], [fbDs]] = await Promise.all(['mockify.mock', 'mockify.feedback']
        .map((kind) => sdk.Dataset.forKind(kind, projectId || undefined)));
      if (!mocksDs || !fbDs) throw new Error('this project has no mocks / mock-feedback dataset (set MOCKIFY.project to the mock project id)');
      Object.assign(data, { sdk, mocksDs, fbDs });
      await loadMock();
      await refresh();
      mocksDs.onRowsChanged(loadMock);
      fbDs.onRowsChanged(() => refresh());
    } catch (err) {
      data.error = `Feedback is off: ${err?.message || err}`;
      data.fbDs = null;
    }
    finishBoot();
  }
  // Overlapping calls (a write, then the change event it causes) collapse into one run plus at most one more.
  const coalesced = (fn) => {
    let running = null, again = false;
    return () => {
      if (running) { again = true; return running; }
      running = (async () => { try { do { again = false; await fn(); } while (again); } finally { running = null; } })();
      return running;
    };
  };
  const loadMock = coalesced(async () => {
    const found = await data.mocksDs.query({ match: { key: CFG.key } });
    const row = found.rows[0];
    if (!row) throw new Error(`no mock row "${CFG.key}" in the mocks dataset`);
    const changed = row.version !== data.mock?.version;
    data.mock = row;
    J = row.input.journey || [];
    if (changed) render();
  });
  // The mock's comments, once: the badge counts the open ones, the panel shows this screen's.
  const refresh = coalesced(async () => {
    if (!data.fbDs || !data.mock) return;
    data.rows = (await data.fbDs.query({ match: { 'input.mock': data.mock.ref }, order_by: { 'input.created': 'asc' } })).rows;
    render();
  });
  function finishBoot() {
    cur = Math.max(0, find(location.hash.slice(1)));
    if (typeof window.mockGo !== 'function' && J.length) show(J[cur].id);
    render();
    contrast();
  }

  async function saveFeedback() {
    const s = J[cur];
    const text = draft.text.trim();
    if (!text && !draft.image) return;
    const input = { mock: data.mock.ref, step: s.id, text: text || '(image)', status: 'open', created: new Date().toISOString() };
    if (draft.decision) input.decision = draft.decision;
    if (draft.image) input.screenshot = draft.image;
    if (draft.anchor) input.anchor = draft.anchor;
    if (draft.shot) input.element_shot = draft.shot;
    const key = `${CFG.key}-${s.id}-${Date.now().toString(36)}`;
    $('.save').disabled = true;
    try {
      await data.fbDs.append([{ key, input }]);
      draft = { ...NO_DRAFT };
      justSaved = key;   // saved: the box folds away and the new entry shows, highlighted
      panelKey = '';   // refresh redraws the open panel once
      await refresh();
    } catch (err) {
      panel.insertAdjacentHTML('beforeend', `<div class="msg">Not saved: ${esc(err?.message || err)}</div>`);
      $('.save').disabled = false;
    }
  }

  // The feedback as one markdown document — what the review panel shows, Copy copies and Send sends.
  const extOf = (dataUrl) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[
    (String(dataUrl).match(/^data:([^;,]+)/) || [])[1]] || 'bin';
  function feedbackMarkdown(rows) {
    const m = data.mock, base = data.fbDs?.asset_ref || '';
    const fileOf = (r, field) => (base ? `${base}/rows/${r.key}/input/${field}.${extOf(r.input[field])}` : `${field} on row ${r.key}`);
    const byStep = {};
    rows.forEach((r) => (byStep[r.input.step] ||= []).push(r));
    const steps = J.filter((s) => byStep[s.id]);
    const out = [`# Feedback on mock "${m?.input.title || CFG.key}" (\`${CFG.key}\`)`, '',
      `${rows.length} comment(s) on ${steps.length} screen(s).`,
      ...(m?.input.folder || CFG.folder ? [`Mock folder: \`${m?.input.folder || CFG.folder}\``] : []), ''];
    steps.forEach((s) => {
      out.push(`## ${find(s.id) + 1}. ${s.title} — \`${s.id}\` (${s.app})`, '');
      byStep[s.id].forEach((r) => {
        const i = r.input;
        const where = [i.decision && `**${i.decision}**`, i.anchor && `on "${i.anchor.label}" \`${i.anchor.selector}\``].filter(Boolean).join(' · ');
        out.push(`- ${where ? where + ' — ' : ''}${i.text.trim().replace(/\n/g, '\n  ')}`);
        if (i.screenshot) out.push(`  - image: \`${fileOf(r, 'screenshot')}\``);
        if (i.element_shot) out.push(`  - element: \`${fileOf(r, 'element_shot')}\``);
      });
      out.push('');
    });
    out.push('---', `The rows: the mock-feedback dataset, \`input.mock = ${m?.ref}\`, \`input.status = submitted\` (mockify skill, "Reading feedback").`);
    return out.join('\n');
  }

  // The session the feedback goes to, by the mock row's `session` — its name is shown on the Send buttons.
  let target = { id: '', proc: null, name: '' };
  async function sessionOf() {
    const id = data.mock?.input.session || '';
    if (!id || !data.sdk) return null;
    if (target.id !== id) {
      const proc = await data.sdk.dataManager.getByTypeId(new data.sdk.TypeId('agentic_process', id)).catch(() => null);
      target = { id, proc, name: proc ? (proc.name || proc.title || `session ${id.slice(0, 8)}`) : '' };
    }
    return target.proc;
  }
  // How the feedback reaches the session: the markdown as a FILE in its input folder, and ONE line that
  // points at it — the app's own attachment convention ("File <name> is available here: <path>"). A
  // multi-line prompt typed into a terminal session lands in its input box and is never submitted.
  const noteFor = (rows, name, path) => {
    const screens = new Set(rows.map((r) => r.input.step)).size;
    return `Mock feedback on "${data.mock?.input.title || CFG.key}" (${CFG.key}): ${rows.length} comment(s) on ${screens} screen(s). `
      + `File ${name} is available here: ${path} — read it and follow the mockify skill, "Reading feedback".`;
  };
  async function sendText(rows) {
    const proc = await sessionOf();
    if (!proc) throw new Error(data.mock?.input.session ? `session ${data.mock.input.session} not found` : 'the mock row names no session');
    const sdk = data.sdk;
    const dir = await sdk.dataManager.callAction(new sdk.ActionInfo('input-dir', 'agentic_process', proc.id, 'GET'));
    if (!dir?.abs_path || !dir?.compute_node_id) throw new Error("could not find the session's input folder");
    const name = `mock-feedback-${CFG.key}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`;
    const file = new File([feedbackMarkdown(rows)], name, { type: 'text/markdown' });
    const uploads = await sdk.fsStore.getState().uploadFiles(new sdk.TypeId(dir.compute_node_id), dir.abs_path, [file]);
    await Promise.all(uploads.map((u) => u.waitForCompletion()));
    await proc.enqueue(noteFor(rows, name, `${dir.abs_path}/${name}`), 'mockify');
  }

  async function submitAll() {
    const rows = openRows();
    if (!rows.length || !data.mock) return;
    const btn = $('.execute'); btn.disabled = true;
    try {
      // The session hears first: if anything after fails, the comments are still open and Send can run again.
      const m = data.mock;
      await sendText(rows);   // the same markdown the review panel showed, as a file
      await data.fbDs.putMany(rows.map((r) => ({ key: r.key, input: { ...r.input, status: 'submitted' } })),
        { expected: Object.fromEntries(rows.map((r) => [r.key, r.version])) });
      await data.mocksDs.put(CFG.key, { input: { ...m.input, status: 'submitted' } }, { expected: m.version });
      open = 'feedback';
      await Promise.all([refresh(), loadMock()]);
      panelKey = panelState();
      panel.innerHTML = head() + `<h4>Submitted</h4><div class="msg">${rows.length} comment(s) sent to ${esc(target.name || 'the session that builds this mock')}.</div>`;
      placePanel(); panel.hidden = false;
    } catch (err) {
      setPanel('send');
      panel.insertAdjacentHTML('beforeend', `<div class="msg">Not sent: ${esc(err?.message || err)}</div>`);
    } finally { render(); }
  }

  // ── controls ──
  $('.back').onclick = () => go(mainBefore(cur));
  $('.next').onclick = () => go(onwardOf(cur));
  $('.restart').onclick = () => { setPanel(''); go(0); };
  $('.steps').onclick = () => setPanel(open === 'steps' ? '' : 'steps');
  $('.execute').onclick = submitAll;
  $('.scope').onclick = () => setPicking(!picking);
  const minLabel = () => { const m = bar.classList.contains('min'), b = $('.min-btn'); b.textContent = m ? '+' : '–'; b.title = m ? 'Restore' : 'Minimise'; b.setAttribute('aria-label', b.title); };
  if (store.get('min')) bar.classList.add('min');
  minLabel();
  $('.min-btn').onclick = () => {
    bar.classList.toggle('min'); setPanel(''); store.set('min', bar.classList.contains('min')); minLabel();
    reclamp();
  };
  panel.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.close')) { setPanel(''); return; }
    const tool = t.closest('.ptool');
    if (tool) { if (tool.dataset.panel === 'feedback') justSaved = ''; setPanel(tool.dataset.panel); return; }
    if (t.closest('.send-now')) { submitAll(); return; }
    if (t.closest('.save-now')) {
      const b = t.closest('.save-now'); b.disabled = true;
      sessionOf().then((proc) => {
        if (!proc) throw new Error('the mock row names no session');
        return proc.enqueue(`Save mock "${CFG.key}" to the repo: the person pressed Save — run the mockify skill's scripts/mock_project.py save ${data.mock.input.repo} ${CFG.key} (SKILL.md "Save to repo").`, 'mockify');
      }).then(() => { b.textContent = `✓ Asked ${target.name} to save it`; })
        .catch((err) => { b.disabled = false; panel.insertAdjacentHTML('beforeend', `<div class="msg">Not asked: ${esc(err?.message || err)}</div>`); });
      return;
    }
    if (t.closest('.send-again')) {
      const b = t.closest('.send-again'); b.disabled = true;
      sendText(sentRows())
        .then(() => { b.textContent = `✓ Sent to ${target.name}`; })
        .catch((err) => { b.disabled = false; panel.insertAdjacentHTML('beforeend', `<div class="msg">Not sent: ${esc(err?.message || err)}</div>`); });
      return;
    }
    if (t.closest('.review-all')) { setPanel('send'); return; }
    if (t.closest('.copy-md')) {
      const b = t.closest('.copy-md'), md = feedbackMarkdown(b.dataset.which === 'sent' ? sentRows() : openRows());
      const done = () => { b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = '⧉ Copy'; }, 1500); };
      navigator.clipboard?.writeText(md).then(done, () => {
        const ta = Object.assign(document.createElement('textarea'), { value: md });
        document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); done();
      });
      return;
    }
    if (t.closest('.open-folder')) {
      const folder = data.mock?.input.folder || CFG.folder, node = data.sdk?.dataContext?.computeNodeTypeId;
      if (folder && node) new data.sdk.FSRef(folder, node).open().catch((err) => panel.insertAdjacentHTML('beforeend', `<div class="msg">Could not open the folder: ${esc(err?.message || err)}</div>`));
      return;
    }
    if (t.closest('.hints-toggle')) { hints = !hints; store.set('hints', hints); markHints(true); renderPanel(); return; }
    const row = t.closest('[data-i]');
    if (row) { setPanel(''); go(+row.dataset.i); return; }
    if (t.closest('.new-comment')) { justSaved = ''; renderPanel(); return; }
    const chip = t.closest('[data-dec]');
    if (chip) { draft.decision = draft.decision === chip.dataset.dec ? '' : chip.dataset.dec; renderPanel(); return; }
    if (t.closest('.attach')) { $('.file').click(); return; }
    if (t.closest('.clear-img')) { draft.image = ''; renderPanel(); return; }
    if (t.closest('.clear-anchor')) { draft.anchor = null; draft.shot = ''; renderPanel(); return; }
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
  addEventListener('resize', () => { reclamp(); contrast(); drawPins(); });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picking) { setPicking(false); return; }
    if (e.key === 'Escape' && open) { setPanel(''); return; }
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
