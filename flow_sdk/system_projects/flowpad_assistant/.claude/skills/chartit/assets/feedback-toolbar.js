/* chartit feedback toolbar v1 — paste inline as the LAST script in every chart's <body>. Self-contained.
 * Contract: SKILL.md §3. The page defines window.CHARTIT = {key, chart?} and window.chartitRender(value),
 * which draws the chart and marks every element a reviewer can comment on with data-target="<id>". */
(() => {
  const CFG = window.CHARTIT || {};
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem('chartit:' + k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem('chartit:' + k, JSON.stringify(v)); } catch { /* no storage here */ } },
  };
  const docStyle = document.createElement('style');
  // The picked element and the ones with comments are marked in the page itself.
  docStyle.textContent = `[data-target]{cursor:pointer}
    [data-target].ck-on{filter:drop-shadow(0 0 3px #8b5cf6) drop-shadow(0 0 6px #8b5cf6)}
    [data-target].ck-has text{text-decoration:underline wavy #8b5cf6}`;
  document.head.append(docStyle);

  const data = { sdk: null, chart: null, chartsDs: null, fbDs: null, rows: [], error: '' };
  let target = '';                                     // the element feedback is about ('' = the whole chart)
  let draft = { text: '', image: '' };
  let open = false;
  const openRows = () => data.rows.filter((r) => r.input.status === 'open');
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const labelOf = (id) => {
    if (!id) return 'Whole chart';
    const el = document.querySelector(`[data-target="${CSS.escape(id)}"]`);
    return el?.dataset.label ? `${id} · ${el.dataset.label}` : id;
  };

  function draw(value) {
    if (typeof window.chartitRender !== 'function' || !value) return;
    window.chartitRender(value);
    if (value.title) document.title = 'Chart — ' + value.title;
    markTargets();
  }
  function markTargets() {
    const counted = new Set(openRows().map((r) => r.input.target).filter(Boolean));
    document.querySelectorAll('[data-target]').forEach((el) => {
      el.classList.toggle('ck-on', el.dataset.target === target);
      el.classList.toggle('ck-has', counted.has(el.dataset.target));
    });
  }

  // ── the host: a shadow root, so the chart's CSS and the bar's never touch ──
  const host = document.createElement('div');
  host.setAttribute('data-chartit', '');
  host.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; --ck-fg: #1f2328; --ck-bg: #ffffff; --ck-edge: #1f2328; --ck-muted: #57606a; --ck-soft: #eef1f4; --ck-accent: #6d28d9; --ck-accent-fg: #fff; }
    :host([data-ck-dark]) { --ck-fg: #f6f8fa; --ck-bg: #16181c; --ck-edge: #f6f8fa; --ck-muted: #9198a1; --ck-soft: #2a2e35; --ck-accent: #a78bfa; --ck-accent-fg: #16181c; }
    * { box-sizing: border-box; font: 13px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bar { display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 6px 0 12px; color: var(--ck-fg); background: var(--ck-bg);
      border: 1.5px solid var(--ck-edge); border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.25); max-width: calc(100vw - 16px); }
    .tag { font-weight: 800; font-size: 10px; letter-spacing: .1em; color: var(--ck-accent); }
    .where { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; padding: 0 4px; }
    .where small { color: var(--ck-muted); font-weight: 400; }
    button { all: unset; box-sizing: border-box; cursor: pointer; color: inherit; border-radius: 999px; white-space: nowrap; }
    button:focus-visible { outline: 2px solid var(--ck-accent); outline-offset: 2px; }
    button[disabled] { opacity: .35; cursor: default; }
    .ico { height: 32px; min-width: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border: 1.5px solid var(--ck-muted); font-weight: 600; }
    .ico:hover { background: var(--ck-soft); }
    .badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--ck-accent); color: var(--ck-accent-fg); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
    .submit { height: 32px; padding: 0 12px; font-weight: 700; border: 1.5px solid var(--ck-accent); color: var(--ck-accent); }
    .submit:hover { background: var(--ck-soft); }
    [hidden] { display: none !important; }
    .panel { position: absolute; bottom: 52px; left: 50%; transform: translateX(-50%); width: min(440px, calc(100vw - 16px)); max-height: 70vh; overflow: auto;
      background: var(--ck-bg); color: var(--ck-fg); border: 1.5px solid var(--ck-edge); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.3); padding: 10px; }
    h4 { margin: 4px 2px 8px; font-weight: 700; font-size: 11px; color: var(--ck-muted); text-transform: uppercase; letter-spacing: .06em; }
    .hint { color: var(--ck-muted); margin: 0 2px 8px; }
    .chip { padding: 3px 9px; border: 1.5px solid var(--ck-accent); color: var(--ck-accent); border-radius: 999px; font-size: 12px; font-weight: 700; display: inline-block; margin-bottom: 8px; }
    textarea { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 76px; padding: 8px 10px; border: 1.5px solid var(--ck-muted); border-radius: 8px; white-space: pre-wrap; color: var(--ck-fg); }
    textarea:focus { border-color: var(--ck-accent); }
    .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .actions .save { margin-left: auto; height: 32px; padding: 0 16px; font-weight: 700; background: var(--ck-accent); color: var(--ck-accent-fg); }
    .attach { height: 32px; padding: 0 10px; border: 1.5px dashed var(--ck-muted); }
    .thumb { max-width: 100%; max-height: 140px; border-radius: 6px; border: 1px solid var(--ck-muted); display: block; margin-top: 8px; }
    .item { border-top: 1px solid var(--ck-soft); padding: 8px 2px; }
    .item .meta { color: var(--ck-muted); font-size: 11px; display: flex; gap: 8px; align-items: center; }
    .item .del { margin-left: auto; color: var(--ck-muted); padding: 2px 6px; }
    .item .go { color: var(--ck-accent); font-weight: 700; }
    .msg { padding: 8px; border-radius: 8px; background: var(--ck-soft); margin-top: 8px; }
  </style>
  <div class="bar" role="toolbar" aria-label="Chart feedback">
    <span class="tag">CHART</span>
    <span class="where"></span>
    <button class="ico fb" title="Comment on the picked element (click one in the chart first)">💬 Feedback <span class="badge fb-count" hidden></span></button>
    <button class="submit" hidden title="Send all saved feedback to the session that builds this chart">Submit <span class="submit-n"></span></button>
  </div>
  <div class="panel" hidden></div>`;
  document.body.append(host);
  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');

  function render() {
    const n = openRows().length;
    $('.where').innerHTML = data.error && !data.chart ? `<small>${esc(data.error)}</small>`
      : `${esc(labelOf(target))} <small>${target ? '· picked' : '· click an element to pick it'}</small>`;
    $('.fb-count').hidden = !n; $('.fb-count').textContent = n;
    $('.submit').hidden = !n; $('.submit-n').textContent = `(${n})`;
    markTargets();
    if (open) renderPanel();
  }

  function renderPanel() {
    panel.hidden = !open;
    if (!open) return;
    let html = `<h4>Feedback</h4><span class="chip">${esc(labelOf(target))}</span>`;
    if (!data.fbDs) { panel.innerHTML = html + `<div class="msg">${esc(data.error || 'Loading…')}</div>`; return; }
    html += `<div class="hint">Click any box or arrow in the chart to change what this comment is about.</div>`
      + `<textarea placeholder="What should change? (paste an image here too)"></textarea>`
      + (draft.image ? `<img class="thumb" src="${draft.image}" alt="attached image">` : '')
      + `<div class="actions"><button class="attach">📎 ${draft.image ? 'Replace image' : 'Attach image'}</button>`
      + (draft.image ? '<button class="clear-img" title="Remove the image">✕</button>' : '')
      + `<button class="save">Save</button></div><input class="file" type="file" accept="image/*" hidden>`;
    if (data.rows.length) {
      html += `<h4 style="margin-top:14px">Saved (${data.rows.length})</h4>` + data.rows.map((r) => {
        const i = r.input;
        return `<div class="item"><div class="meta"><button class="go" data-pick="${esc(i.target || '')}">${esc(labelOf(i.target))}</button><span>${esc(i.status)}</span>`
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

  // ── data: the chart row and its feedback rows, through the Flowpad SDK ──
  const coalesced = (fn) => {
    let running = null, again = false;
    return () => {
      if (running) { again = true; return running; }
      running = (async () => { try { do { again = false; await fn(); } while (again); } finally { running = null; } })();
      return running;
    };
  };
  const loadChart = coalesced(async () => {
    const row = (await data.chartsDs.query({ match: { key: CFG.key } })).rows[0];
    if (!row) throw new Error(`no chart row "${CFG.key}" in the charts dataset`);
    const changed = row.version !== data.chart?.version;
    data.chart = row;
    if (changed) { draw(row.input); render(); }
  });
  const refresh = coalesced(async () => {
    if (!data.fbDs || !data.chart) return;
    data.rows = (await data.fbDs.query({ match: { 'input.chart': data.chart.ref }, order_by: { 'input.created': 'asc' } })).rows;
    render();
  });
  async function boot() {
    if (CFG.chart) draw(CFG.chart);                    // offline copy: draws at once, replaced by the row
    let sdk;
    try { sdk = await import('/sdk/flowpad-sdk.js'); } catch { sdk = null; }
    if (!sdk || !CFG.key) {
      data.error = CFG.key ? 'Feedback needs this chart served by Flowpad (`flow app serve`).' : 'No CHARTIT.key on this page — feedback is off.';
      return render();
    }
    try {
      await sdk.initSdk();
      let projectId = null;
      try { const { app } = await sdk.resolveAppHost(); projectId = app?.project_id || null; } catch { /* not an app endpoint */ }
      projectId = projectId || sdk.dataContext?.projectTypeId?.id || null;
      const [[chartsDs], [fbDs]] = await Promise.all(['chartit.chart', 'chartit.feedback']
        .map((kind) => sdk.Dataset.forKind(kind, projectId || undefined)));
      if (!chartsDs || !fbDs) throw new Error('this project has no charts / chart-feedback dataset (chartit scripts/install_data.py)');
      Object.assign(data, { sdk, chartsDs, fbDs });
      await loadChart();
      await refresh();
      chartsDs.onRowsChanged(loadChart);               // the session edits the row → the chart redraws live
      fbDs.onRowsChanged(() => refresh());
    } catch (err) {
      data.error = `Feedback is off: ${err?.message || err}`;
      data.fbDs = null;
    }
    render();
  }

  async function saveFeedback() {
    const text = draft.text.trim();
    if (!text && !draft.image) return;
    const input = { chart: data.chart.ref, text: text || '(image)', status: 'open', created: new Date().toISOString() };
    if (target) input.target = target;
    if (draft.image) input.screenshot = draft.image;
    $('.save').disabled = true;
    try {
      await data.fbDs.append([{ key: `${CFG.key}-${Date.now().toString(36)}`, input }]);
      draft = { text: '', image: '' };
      await refresh();
    } catch (err) {
      panel.insertAdjacentHTML('beforeend', `<div class="msg">Not saved: ${esc(err?.message || err)}</div>`);
      $('.save').disabled = false;
    }
  }

  async function submitAll() {
    const rows = openRows();
    if (!rows.length || !data.chart) return;
    const btn = $('.submit'); btn.disabled = true;
    try {
      // The session hears first: if anything after fails, the comments are still open and Submit can run again.
      const c = data.chart;
      const lines = rows.map((r) => `- ${labelOf(r.input.target)}: ${r.input.text.slice(0, 160)}${r.input.screenshot ? ' [image]' : ''}`);
      const prompt = `Feedback submitted on chart "${CFG.key}" — ${rows.length} comment(s).\n`
        + `Read them as typed rows (chartit skill, "Reading feedback"): the chart-feedback dataset, match input.chart = ${c.ref} and input.status = submitted.\n`
        + lines.join('\n');
      if (c.input.session) {
        const proc = await data.sdk.dataManager.getByTypeId(new data.sdk.TypeId('agentic_process', c.input.session));
        if (!proc) throw new Error(`session ${c.input.session} not found`);
        await proc.enqueue(prompt, 'chartit');
      }
      await data.fbDs.putMany(rows.map((r) => ({ key: r.key, input: { ...r.input, status: 'submitted' } })),
        { expected: Object.fromEntries(rows.map((r) => [r.key, r.version])) });
      await data.chartsDs.put(CFG.key, { input: { ...c.input, status: 'submitted' } }, { expected: c.version });
      await Promise.all([refresh(), loadChart()]);
      open = true; panel.hidden = false;
      panel.innerHTML = `<h4>Submitted</h4><div class="msg">${rows.length} comment(s) sent${c.input.session ? ' to the session that builds this chart — it will redraw here when revised' : ' — no session on the chart row, so nothing was sent; they are saved as submitted'}.</div>`;
    } catch (err) {
      open = true; renderPanel();
      panel.insertAdjacentHTML('beforeend', `<div class="msg">Not submitted: ${esc(err?.message || err)}</div>`);
    } finally { btn.disabled = false; }
  }

  // ── controls ──
  const pick = (id) => { target = target === id ? '' : id; render(); };
  document.addEventListener('click', (e) => {
    if (e.composedPath().includes(host)) return;
    const el = e.target.closest?.('[data-target]');
    if (el) { pick(el.dataset.target); if (!open) { open = true; renderPanel(); } }
  });
  $('.fb').onclick = () => { open = !open; renderPanel(); };
  $('.submit').onclick = submitAll;
  panel.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.attach')) { $('.file').click(); return; }
    if (t.closest('.clear-img')) { draft.image = ''; renderPanel(); return; }
    if (t.closest('.save')) { saveFeedback(); return; }
    const go = t.closest('[data-pick]');
    if (go) { target = go.dataset.pick; render(); return; }
    const del = t.closest('.del');
    if (del) data.fbDs.deleteRow(del.dataset.key, del.dataset.v ? { expected: del.dataset.v } : {}).then(refresh);
  });
  panel.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) readImage(f); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { open = false; renderPanel(); } });

  // The bar contrasts with the page: dark bar on a light page and the other way round.
  const dark = () => document.documentElement.classList.contains('dark');
  const contrast = () => host.toggleAttribute('data-ck-dark', !dark());
  new MutationObserver(contrast).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  contrast();
  render();
  boot();
})();
