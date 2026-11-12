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
    [data-dead]{opacity:.55;cursor:not-allowed!important}
    .mk-pick{outline:2px solid #6d28d9!important;outline-offset:2px!important}
    html.mk-picking,html.mk-picking *{cursor:crosshair!important}
    [data-change].mk-off{display:none!important}
    [data-change].mk-anchor{display:inline-block;width:1px;min-height:1em;vertical-align:middle}
    [data-step] [data-change].mk-was{outline:2px solid #cf222e!important;outline-offset:3px!important;background-color:rgba(207,34,46,.09)!important;border-radius:4px}
    .mk-roomy{margin-top:30px!important;margin-bottom:12px!important}
    .mk-pin.mk-quiet{opacity:0;pointer-events:none}
    .mk-off-chip{position:fixed;left:50%;transform:translateX(-50%);pointer-events:auto;cursor:pointer;background:#1F6FEB;color:#fff;font:700 12.5px system-ui,sans-serif;padding:6px 14px;border-radius:999px;box-shadow:0 4px 14px rgba(31,111,235,.45)}
    .mk-off-chip.up{top:10px}.mk-off-chip.down{bottom:86px}
    .mk-flash{animation:mk-flash 1.2s ease 1}@keyframes mk-flash{0%,100%{outline-color:#1F6FEB}30%,70%{outline-color:#f0b400;outline-width:4px}}.mk-pin{transition:opacity .12s}
    .mk-removed{opacity:.5!important;outline:2px dashed #cf222e!important;outline-offset:3px!important;text-decoration:line-through!important;background-color:rgba(207,34,46,.09)!important}
    html.mk-clean [data-mk-after]{outline:none!important;background-color:transparent!important;animation:none!important}
    [data-mk-after]{outline:2px solid #1a7f37!important;outline-offset:3px!important;background-color:rgba(26,127,55,.11)!important;border-radius:6px;animation:mk-in .35s ease}
    .mk-dl{position:fixed;pointer-events:auto;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:26px;height:22px;padding:0 4px;box-sizing:border-box;border-radius:11px;
      font:800 11.5px/1 system-ui,sans-serif;color:#fff;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)}
    .mk-dl:hover{transform:scale(1.15)}
    .mk-dl.old{background:#cf222e}.mk-dl.new{background:#1a7f37}.mk-dl.scr{width:auto;padding:0 7px;border-radius:11px}
    .mk-dl.rej{box-shadow:0 0 0 2px #cf222e,0 1px 5px rgba(0,0,0,.45)}
    .mk-dl.rej::after{content:'✕';position:absolute;right:-7px;top:-7px;width:13px;height:13px;border-radius:50%;background:#cf222e;color:#fff;font:800 8px/13px system-ui;text-align:center}
    .mk-scr-tag{position:fixed;top:6px;left:50%;transform:translateX(-50%);pointer-events:none;padding:3px 12px;border-radius:999px;
      font:800 11px/16px system-ui,sans-serif;letter-spacing:.06em;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35)}
    .mk-scr-tag.existing{background:#57606a}.mk-scr-tag.new{background:#1a7f37}
    @keyframes mk-in{from{opacity:0;transform:translateY(-4px)}}
    .mk-pins{position:fixed;inset:0;pointer-events:none;z-index:2147483645}
    .mk-pin{position:fixed;pointer-events:auto;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:#fff;color:#1F6FEB;border:2px solid #1F6FEB;
      font:800 12px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);padding:0}
    .mk-pin:hover{transform:scale(1.12)}.mk-pin{touch-action:none;user-select:none;cursor:grab}.mk-pin.rev{background:#1F6FEB;color:#fff}.mk-pin.on{box-shadow:0 0 0 4px rgba(31,111,235,.35),0 2px 8px rgba(0,0,0,.3)}
    .mk-pin.scr{border-radius:8px;width:auto;padding:0 8px;margin-left:0}
    .mk-hover{position:fixed;z-index:2147483646;width:300px;background:#1f2328;color:#f6f8fa;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:10px 12px;font:12.5px/1.45 system-ui,sans-serif}
    .mk-hover b{display:block;font-size:13.5px;margin:0 18px 4px 0}.mk-hover .mk-tags{display:flex;gap:5px;margin-bottom:6px}
    .mk-hover .mk-tags span{font:700 10px ui-monospace,Menlo,monospace;color:#f6f8fa;background:rgba(255,255,255,.14);border-radius:5px;padding:1px 6px}
    .mk-hover p{margin:0 0 8px;color:#c9d1d9}.mk-hover .mk-x{position:absolute;top:6px;right:8px;background:none;border:0;color:#8b949e;cursor:pointer;font-size:13px}
    .mk-hover .mk-tg{display:flex;gap:4px;margin-bottom:6px}.mk-hover .mk-tg button{flex:1;height:28px;border-radius:7px;border:1.5px solid #484f58;background:transparent;color:#c9d1d9;font:700 12px system-ui;cursor:pointer}
    .mk-hover .mk-tg .mk-ok.on{background:#1a7f37;border-color:#1a7f37;color:#fff}.mk-hover .mk-tg .mk-rj.on{background:#cf222e;border-color:#cf222e;color:#fff}
    .mk-hover .mk-op{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}.mk-hover .mk-op button{border:1.5px solid #484f58;background:transparent;color:#c9d1d9;border-radius:999px;padding:3px 9px;font:12px system-ui;cursor:pointer}.mk-hover .mk-op .on{border-color:#a78bfa;color:#a78bfa;font-weight:700}
    .mk-hover textarea{width:100%;box-sizing:border-box;min-height:46px;background:#0d1117;color:#f6f8fa;border:1.5px solid #484f58;border-radius:8px;padding:6px 8px;font:12.5px system-ui;resize:vertical}
    .mk-hover .mk-row{display:flex;align-items:center;gap:8px;margin-top:6px}.mk-hover .mk-hint{flex:1;color:#8b949e;font-size:11px}
    .mk-hover .mk-sv{height:28px;padding:0 14px;border-radius:999px;border:0;background:#a78bfa;color:#16181c;font-weight:800;cursor:pointer}.mk-hover .mk-sv:disabled{opacity:.4;cursor:default}
    .mk-pin.rej{border-color:#cf222e;color:#cf222e}.mk-pin.rej.rev{background:#cf222e;color:#fff}
    .mk-sub{position:absolute;right:-9px;top:-9px;width:18px;height:18px;border-radius:50%;border:2px solid #fff;font:800 9px/1 system-ui;display:flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;background:#1a7f37;box-shadow:0 1px 4px rgba(0,0,0,.3)}
    .mk-sub:hover{transform:scale(1.15)}.mk-sub.no{background:#cf222e}
    .mk-sub.c::after{content:'';position:absolute;right:-4px;bottom:-4px;width:7px;height:7px;border-radius:50%;background:#f0b400;border:1.5px solid #fff}
    @media (prefers-reduced-motion:reduce){[data-mk-after]{animation:none}}`;
  document.head.append(docStyle);
  if ((store.get('view') || 'diff') !== 'diff') document.documentElement.classList.add('mk-clean');

  // ── changes on today (v3): every screen is the product today; a step's `changes` are pinned on it ──
  // In the screen: the today element carries data-change="<id>"; its suggested version is a
  // <template data-change-after="<id>"> next to it (empty = the element goes). mode 'screen' changes open `to`.
  const rev = {};                       // "<step>:<change>" → revealed
  // diff (default): today in red AND the suggestion in green, side by side · today: the screen as it is · after: only the suggestion
  let view = store.get('view') || 'diff';
  const allMode = true;   // every change of an existing screen is shown; `view` says how
  const pinMoved = store.get('pinMoved') || {};   // "<step>:<change>" → {dx, dy}: where the reviewer dragged a pin                  // Today | All is global: All reveals every change on every screen
  const chPins = document.createElement('div');
  chPins.className = 'mk-pins'; chPins.setAttribute('data-mockify', '');
  document.body.append(chPins);
  // a NEW screen (tag "new") is all new: it carries no change annotation. The tag never decides the walk.
  const changesOf = (st) => (st && st.tag !== 'new' && st.changes) || [];
  const isNew = (st) => !!st && st.tag === 'new';
  const secOf = (st) => st && document.querySelector(`[data-step="${CSS.escape(st.id)}"]`);
  function setRev(st, c, on) {
    const sec = secOf(st); if (!sec || c.mode === 'screen') return;
    rev[st.id + ':' + c.id] = on;
    const q = CSS.escape(c.id);
    sec.querySelectorAll(`[data-mk-after="${q}"]`).forEach((e) => e.remove());
    const els = [...sec.querySelectorAll(`[data-change="${q}"]`)];
    els.forEach((e) => e.classList.remove('mk-off', 'mk-removed', 'mk-was', 'mk-roomy'));
    if (!on || view === 'today') return;
    // one template per today element (a change may touch several: every cell of a column); empty = removal
    const tpls = [...sec.querySelectorAll(`template[data-change-after="${q}"]`)];
    if (!tpls.some((t) => t.innerHTML.trim())) { els.forEach((e) => { if (!e.classList.contains('mk-anchor')) e.classList.add(view === 'after' ? 'mk-off' : 'mk-removed'); }); return; }
    // a block gets room above it for its diff label, so nothing it labels is covered
    const roomy = (e) => { const d = getComputedStyle(e).display; if (/^(block|flex|grid|flow-root|list-item)$/.test(d)) e.classList.add('mk-roomy'); };
    els.forEach((e) => { if (e.classList.contains('mk-anchor')) return; if (view === 'after') e.classList.add('mk-off'); else { e.classList.add('mk-was'); roomy(e); } });
    tpls.forEach((tpl) => {
      const frag = tpl.content.cloneNode(true);
      const kids = [...frag.children];
      kids.forEach((ch) => ch.setAttribute('data-mk-after', c.id));
      tpl.after(frag);
      if (view === 'diff') kids.forEach(roomy);
    });
  }
  const isRev = (st, c) => !!rev[st.id + ':' + c.id];
  // where a pin sits: the revealed version, else the today element, else a column at the left
  function pinAt(sec, c, k) {
    const q = CSS.escape(c.id);
    const el = sec.querySelector(`[data-mk-after="${q}"]`) || [...sec.querySelectorAll(`[data-change="${q}"]`)].find((e) => e.getClientRects().length);
    const r = el && el.getBoundingClientRect();
    if (!r || (!r.width && !r.height && !el.classList.contains('mk-anchor'))) return { x: 22, y: 70 + k * 34 };
    // the centre of what changed (of all its pieces, when it has several), kept on screen
    const all = [...sec.querySelectorAll(`[data-mk-after="${q}"]`)].concat([...sec.querySelectorAll(`[data-change="${q}"]`)].filter((e) => e.getClientRects().length && !e.classList.contains('mk-off')))
      .map((e) => e.getBoundingClientRect()).filter((b) => b.width || b.height);
    const first = all[0] || r;
    const cx = first.left + first.width / 2, cy = first.height < 44 ? first.top - 6 : first.top + Math.min(first.height / 2, 40);   // a small element: centred just above it, so it stays clickable
    return { x: Math.max(16, Math.min(innerWidth - 16, cx)), y: Math.max(16, Math.min(innerHeight - 70, cy)) };
  }

  // The mock tree (assets/mock-tree.js, compiled by scripts/tree.py): the screens in DFS order. Next, Back, Restart,
  // the hash, a data-next click and the screens list all move through window.mock -- the bar only paints.
  const mock = window.mock;
  if (!mock) { console.error('mockify: no window.mock -- build the page with build_mock.py (it inlines mock-tree.js and MOCKIFY.tree)'); return; }
  const J = mock.screens;          // {id, app, title, tag, num, depth, via_kind, when, state, actions[], changes[], decisions[], note?, expect?[]}
  let cur = 0;
  const data = { sdk: null, mock: null, mocksDs: null, fbDs: null, rows: [], error: '' };
  const openRows = () => data.rows.filter((r) => r.input.status === 'open');
  const sentRows = () => data.rows.filter((r) => r.input.status !== 'open');
  const stepRows = () => data.rows.filter((r) => r.input.step === J[cur]?.id);

  const isBranch = (s) => s.via_kind === 'branch' || s.via_kind === 'alt';
  const find = (id) => mock.indexOf(id);   // -1 when there is no such screen
  const show = (id) => {
    document.querySelectorAll('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== id; });
    window.mockifyFit?.();   // build_mock's fit: the shown screen fills the frame
  };
  // Paint the screen the tree is on. Every move goes through window.mock; this is its one listener.
  const paint = (record = true) => {
    if (!J.length) return;
    cur = mock.index;
    const id = J[cur].id;
    if (open.startsWith('change:')) { open = ''; panel.hidden = true; }   // a change belongs to its screen
    if (typeof hoverEl !== 'undefined' && mini) { mini = null; hoverEl.hidden = true; }
    if (record && location.hash.slice(1) !== id) history.pushState(null, '', '#' + id);
    show(id);
    if (typeof nextIx !== 'undefined') nextIx = 0;
    if (allMode) changesOf(J[cur]).forEach((c) => { if (!isRev(J[cur], c)) setRev(J[cur], c, true); });
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
    .where { display: flex; flex-direction: column; box-sizing: border-box; flex: 0 0 272px; width: 272px; min-width: 0; padding: 0 6px; }
    .stag { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 5px; font: 800 10px/16px system-ui, sans-serif; letter-spacing: .05em; color: #fff; vertical-align: 1px; }
    .stag.ex { background: #57606a; } .stag.new { background: #1a7f37; }
    .who { display: inline-block; max-width: 190px; vertical-align: bottom; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; padding: 0 6px; margin-right: 4px; border-radius: 9px; background: var(--mk-soft); font-size: 10px; line-height: 15px; white-space: nowrap; transition: background .3s, color .3s; }
    .who.switch { background: var(--mk-accent); color: #fff; }
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
    .chg { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 4px 0 10px; border: 1.5px solid #1F6FEB; border-radius: 999px; color: #1F6FEB; font-weight: 700; }
    .chg .cnt { font-weight: 700; color: #1F6FEB; }
    .sw { display: inline-flex; border-radius: 999px; background: var(--mk-soft); padding: 2px; }
    .sw button { height: 24px; padding: 0 9px; font-size: 12px; font-weight: 700; color: var(--mk-muted); }
    .sw button.on { background: #1F6FEB; color: #fff; }
    .vote { display: flex; gap: 6px; margin: 8px 0; } .vote button { flex: 1; height: 30px; border-radius: 8px; border: 1.5px solid var(--mk-muted); font-weight: 700; text-align: center; }
    .vote .vy.on { background: #1a7f37; border-color: #1a7f37; color: #fff; } .vote .vn.on { background: #cf222e; border-color: #cf222e; color: #fff; }
    .reveal { display: block; width: 100%; height: 32px; text-align: center; border: 1.5px solid #1F6FEB; color: #1F6FEB; font-weight: 700; margin: 8px 0 4px; }
    .reveal.on { background: #1F6FEB; color: #fff; }
    .crow { display: flex; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 8px; align-items: center; }
    .crow:hover { background: var(--mk-soft); } .crow i { font-style: normal; flex: none; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #1F6FEB; color: #1F6FEB; font-size: 11px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; }
    .crow small { margin-left: auto; font-weight: 700; } .crow small.yes { color: #1a7f37; } .crow small.no { color: #cf222e; }
    .min .hide-min { display: none !important; }
    @media (max-width: 900px) { .restart-label, .nav .lbl, .trail { display: none; } .step { max-width: 26vw; } .where { flex-basis: 26vw; width: 26vw; } .nav { padding: 0 10px; } }
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
    .row .num { color: var(--mk-muted); min-width: 1.6em; margin-right: 4px; flex: none; font-variant-numeric: tabular-nums; }
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
    <span class="chg hide-min" hidden><button class="cnt" title="Go to the next change on this screen"></button><span class="sw"><button class="sw-d on" title="Today (red) and the suggestion (green), side by side">Diff</button><button class="sw-t" title="The screen as it is today">Today</button><button class="sw-a" title="Only the suggestion">After</button></span></span>
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
    const onward = mock.canNext ? J[cur + 1].id : null;   // where Next goes: the next screen of the walk
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
  // Any other control on a screen is not part of the mock: say so where it was clicked, never a silent no-op.
  // Every app script is stripped, so nothing on a screen is live: anything that LOOKS clickable is inert.
  const inert = (t, screen) => {
    for (let el = t; el && el !== screen; el = el.parentElement) {
      if (el.matches('input, select, textarea, label, [data-dead]') || getComputedStyle(el).cursor === 'pointer') return el;
    }
    return null;
  };
  let tip = null;
  const deadTip = (el) => {
    tip?.remove();
    const r = el.getBoundingClientRect();
    tip = document.createElement('div');
    tip.setAttribute('data-mockify', '');
    tip.textContent = 'Not part of this mock';
    tip.style.cssText = `position:fixed;z-index:2147483646;left:${Math.max(4, r.left)}px;top:${Math.max(4, r.bottom + 6)}px;`
      + 'background:#111827;color:#f9fafb;font:500 12px system-ui;padding:4px 8px;border-radius:6px;pointer-events:none';
    document.body.append(tip);
    setTimeout(() => tip?.remove(), 1400);
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-mockify]') || picking) return;
    const el = e.target.closest('[data-next]');
    if (el) { e.preventDefault(); window.mockifyGo(el.dataset.next); return; }
    const screen = e.target.closest('[data-step]');
    const dead = screen && !e.target.closest('[data-live]') && inert(e.target, screen);
    if (dead) { e.preventDefault(); deadTip(dead); }
  });
  let open = '';
  let panelKey = '';   // what the open panel last drew: re-drawn only when this changes
  const panelState = () => open.startsWith('change:') ? `c|${open}|${cur}|${data.rows.length}` : open === 'feedback'
    ? `f|${cur}|${!!data.fbDs}|${stepRows().map((r) => r.key + r.version).join()}`
    : open === 'save' ? `v|${data.mock?.version}` : open === 'send' ? `s|${data.rows.map((r) => r.key + r.version).join()}` : `${open}|${cur}|${J.length}`;
  const setPanel = (p) => { open = p; renderPanel(); };
  const NO_DRAFT = { text: '', decision: '', image: '', anchor: null, shot: '' };
  const cdraft = {};   // "<step>:<change>" → { vote, choice, text } being written
  let draft = { ...NO_DRAFT };
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
  // Whose screen this is, and on what: every screen says it; a switch between people is flashed.
  const DEV = { desktop: '🖥', iphone: '📱 iPhone', android: '📱 Android' };
  const mockIn = () => data.mock?.input || CFG;
  function whoOf(s) {
    const m = mockIn(), id = s.persona || m.persona || CFG.persona || '';
    const p = (m.personas || CFG.personas || []).find((x) => x.id === id);
    return { id, name: p?.name || '', label: p ? `👤 ${p.name} · ${p.role}` : '', device: DEV[s.device || m.device || CFG.device || 'desktop'] || s.device };
  }
  let lastWho = null;
  function render() {
    if (allMode && J[cur]) changesOf(J[cur]).forEach((c) => { if (!isRev(J[cur], c)) setRev(J[cur], c, true); });
    if (!J.length) { $('.step').textContent = data.error || 'Loading the mock…'; $('.n').textContent = ''; return; }
    const s = J[cur];
    $('.step').innerHTML = `<span class="stag ${isNew(s) ? 'new' : 'ex'}">${isNew(s) ? 'NEW' : 'EXISTING'}</span>` + esc((isBranch(s) ? '↳ ' : '') + s.title);
    const multi = multiApp();
    let on = -1; const cs = crumbs();
    cs.forEach((c, k) => { if (c.from <= cur && (!isBranch(s) || c.app === s.app)) on = k; });
    const trail = cs.map((c, k) => (k === on ? `<span class="on">${esc(c.app)}</span>` : esc(c.app))).join(' ▸ ');
    const w = whoOf(s), switched = lastWho !== null && w.id !== lastWho;
    lastWho = w.id;
    const who = !w.label && w.device === DEV.desktop ? ''
      : `<span class="who${switched ? ' switch' : ''}" title="${esc([w.label, w.device].filter(Boolean).join(' · '))} — whose screen this is, on what">${esc([w.label, w.device].filter(Boolean).join(' · '))}</span>`;
    if (switched) setTimeout(() => $('.who')?.classList.remove('switch'), 1400);
    $('.n').innerHTML = who + (multi ? `<span class="trail">${trail}</span><span class="count">·</span>` : '')
      + `<span class="count">${J.some(isBranch) ? `${s.num} · ` : ''}${cur + 1} of ${J.length}</span>`;
    $('.back').disabled = !mock.canBack;
    $('.next').disabled = !mock.canNext;
    const nOpen = openRows().length;
    $('.exec-n').textContent = nOpen ? `(${nOpen})` : '';
    $('.execute').disabled = !nOpen || !data.mock?.input.session;
    if (open && panelState() !== panelKey) renderPanel();
    markHints();
    drawPins();
    drawChanges();
  }
  function latestVote(st, c) {
    const r = data.rows.filter((x) => x.input.step === st.id && x.input.change === c.id).sort((a, b) => (a.input.created < b.input.created ? 1 : -1))[0];
    return r ? r.input : null;
  }
  function drawChanges() {
    const st = J[cur], cs = changesOf(st), sec = secOf(st);
    $('.chg').hidden = !cs.length;   // the diff switch belongs to a screen that has changes (a NEW screen has none)
    {
      const nRev = cs.filter((c) => c.mode !== 'screen' && isRev(st, c)).length, nPlace = cs.filter((c) => c.mode !== 'screen').length;
      $('.cnt').textContent = `${cs.length} change${cs.length === 1 ? '' : 's'}`;
      $('.sw-d').classList.toggle('on', view === 'diff'); $('.sw-t').classList.toggle('on', view === 'today'); $('.sw-a').classList.toggle('on', view === 'after');
    }
    chPins.innerHTML = '';
    if (!sec || bar.classList.contains('min')) return;
    // changes out of view: a chip that says how many are above / below, and scrolls to the nearest
    const els = cs.map((c) => changeEl(sec, c)).filter(Boolean);
    const above = els.filter((e) => e.getBoundingClientRect().bottom < 0), below = els.filter((e) => e.getBoundingClientRect().top > innerHeight - 90);
    [['up', above, '↑', 'above', above[above.length - 1]], ['down', below, '↓', 'below', below[0]]].forEach(([cls, list, arrow, word, to]) => {
      if (!list.length) return;
      const chip = document.createElement('div');
      chip.className = 'mk-off-chip ' + cls;
      chip.textContent = `${arrow} ${list.length} change${list.length === 1 ? '' : 's'} ${word}`;
      chip.onclick = (e) => { e.stopPropagation(); flashTo(to); };
      chPins.append(chip);
    });
    // every screen says what it is: EXISTING (the product today, its changes drawn as a diff) or NEW
    const tag = document.createElement('div');
    tag.className = 'mk-scr-tag ' + (isNew(st) ? 'new' : 'existing');
    tag.textContent = isNew(st) ? 'NEW SCREEN' : cs.length ? `EXISTING · ${cs.length} change${cs.length === 1 ? '' : 's'}` : 'EXISTING';
    chPins.append(tag);
    // the diff labels: "− n today" on what goes, "+ n <title>" on what comes — always shown, never stacked
    const placed = [];
    // a coloured circle (red = today, green = the suggestion) with the change's number; the words are its tooltip
    const label = (el, cls, text, tip, c, k, v) => {
      const r = el && el.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return;
      const d = document.createElement('div');
      d.className = 'mk-dl ' + cls + (v?.vote === 'no' ? ' rej' : '');
      d.dataset.c = c.id; d.textContent = text;
      d.title = tip + (c.note ? '\n' + c.note : '') + `\n${v?.vote === 'no' ? 'Rejected' : 'Approved'} — click to approve / reject or comment`;
      chPins.append(d);
      let x = Math.max(6, Math.min(innerWidth - d.offsetWidth - 6, r.left - 4)), y = Math.max(28, r.top - 26);
      const hit = () => placed.find((q) => x < q.x + q.w + 6 && x + d.offsetWidth + 6 > q.x && y < q.y + 22 && y + 22 > q.y);
      for (let g = 0, o; (o = hit()) && g < 12; g++) x = o.x + o.w + 8;   // beside the label already there, not on it
      d.style.left = x + 'px'; d.style.top = y + 'px';
      placed.push({ x, y, w: d.offsetWidth });
      d.onclick = (e) => { e.stopPropagation(); if (mini?.c === c.id && !hoverEl.hidden) closeMini(); else openMini(st, c, k, d); };
    };
    if (view !== 'diff') return;   // Today and After are clean screens: only the Diff view is annotated
    cs.forEach((c, k) => {
      const v = latestVote(st, c), q = CSS.escape(c.id), n = k + 1;
      const count = (list) => `${list.length} element${list.length === 1 ? '' : 's'}`;
      const wasAll = [...sec.querySelectorAll(`[data-change="${q}"]`)].filter((e) => e.getClientRects().length && !e.classList.contains('mk-anchor'));
      const nowAll = [...sec.querySelectorAll(`[data-mk-after="${q}"]`)];
      const was = [...sec.querySelectorAll(`[data-change="${q}"]`)].find((e) => e.getClientRects().length && !e.classList.contains('mk-off') && !e.classList.contains('mk-anchor'));
      const now = sec.querySelector(`[data-mk-after="${q}"]`);
      if (c.mode === 'screen') {
        const d0 = chPins.childElementCount;
        label(now || was, 'new scr', `+${n} ↗`, `Change ${n} · opens a NEW screen — ${c.title}`, c, k, v);
        const d = chPins.children[d0];
        if (d && c.to) d.ondblclick = (e) => { e.stopPropagation(); closeMini(); window.mockifyGo(c.to); };
        return;
      }
      if (was) label(was, 'old', `−${n}`, `Change ${n} · ${count(wasAll)} ${now ? 'replaced' : 'removed'} — ${c.title}`, c, k, v);
      if (now) label(now, 'new', `+${n}`, `Change ${n} · ${count(nowAll)} ${was ? 'instead' : 'added'} — ${c.title}`, c, k, v);
    });
  }
  // hovering a pin: a card with the change, its verdict (approved by default) and a comment
  const hoverEl = document.createElement('div');
  hoverEl.className = 'mk-hover'; hoverEl.hidden = true; hoverEl.setAttribute('data-mockify', '');
  document.body.append(hoverEl);
  let mini = null, shownAt = 0, hideT = 0;
  const MIN_OPEN = 500;
  function closeMini() { clearTimeout(hideT); mini = null; hoverEl.hidden = true; hot = ''; drawChanges(); }
  function hideSoon() {
    clearTimeout(hideT);
    const wait = Math.max(MIN_OPEN - (Date.now() - shownAt), 0) + 250;
    hideT = setTimeout(() => {
      if (hoverEl.matches(':hover') || hoverEl.contains(document.activeElement) || (mini && mini.dirty)) return;
      closeMini();
    }, wait);
  }
  document.addEventListener('mousedown', (e) => { if (mini && !hoverEl.hidden && !e.composedPath().some((n) => n.classList && (n.classList.contains('mk-hover') || n.classList.contains('mk-sub')))) closeMini(); }, true);
  function openMini(st, c, k, pin) {
    clearTimeout(hideT);
    if (mini && mini.c === c.id && !hoverEl.hidden) return;
    const v = latestVote(st, c) || {};
    mini = { st: st.id, c: c.id, vote: v.vote || 'yes', choice: v.choice || '', text: v.text && !/^(Yes|No|Approved|Rejected)$/.test(v.text) ? v.text : '', dirty: false };
    const where = c.mode === 'screen' ? '<button class="mk-open" style="background:none;border:0;color:#7ee787;font:700 12px system-ui;cursor:pointer;padding:0">Open the new screen ↗</button>' : 'Red is today, green the suggestion';
    hoverEl.innerHTML = `<button class="mk-x" title="Close">✕</button><b>${k + 1} · ${esc(c.title)}</b>`
      + `<div class="mk-tags">${c.type ? `<span>${esc(c.type)}</span>` : ''}${(c.mode === 'screen' ? 'new screen' : 'in place') !== c.type ? `<span>${c.mode === 'screen' ? 'new screen' : 'in place'}</span>` : ''}</div>`
      + (c.note ? `<p>${esc(c.note)}</p>` : '')
      + `<div class="mk-tg"><button class="mk-ok">✓ Approved</button><button class="mk-rj">✕ Rejected</button></div>`
      + (c.options && c.options.length ? `<div class="mk-op">${c.options.map((o) => `<button data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : '')
      + `<textarea placeholder="Comment (optional)"></textarea><div class="mk-row"><span class="mk-hint">${where}</span><button class="mk-sv"${!data.fbDs || !data.mock ? ' disabled title="Feedback is off here"' : ''}>Save</button></div>`;
    hoverEl.querySelector('textarea').value = mini.text;
    const opener = hoverEl.querySelector('.mk-open');
    if (opener) opener.onclick = (e) => { e.stopPropagation(); closeMini(); window.mockifyGo(c.to); };
    const paint = () => { hoverEl.querySelector('.mk-ok').classList.toggle('on', mini.vote === 'yes'); hoverEl.querySelector('.mk-rj').classList.toggle('on', mini.vote === 'no');
      hoverEl.querySelectorAll('.mk-op button').forEach((b) => b.classList.toggle('on', b.dataset.o === mini.choice)); };
    paint();
    hoverEl.hidden = false; shownAt = Date.now();
    const r = (pin || chPins.children[k])?.getBoundingClientRect(), w = 300, h = hoverEl.offsetHeight;
    hoverEl.style.left = (r ? Math.min(innerWidth - w - 8, Math.max(8, r.left)) : 20) + 'px';
    hoverEl.style.top = (r ? (r.bottom + 6 + h < innerHeight - 70 ? r.bottom + 6 : Math.max(8, r.top - h - 6)) : 60) + 'px';
    hoverEl.oninput = () => { mini.dirty = true; };
    hoverEl.onclick = async (e) => {
      const t = e.target;
      if (t.closest('.mk-x')) { closeMini(); return; }
      if (t.closest('.mk-ok')) { mini.vote = 'yes'; mini.dirty = true; paint(); return; }
      if (t.closest('.mk-rj')) { mini.vote = 'no'; mini.dirty = true; paint(); return; }
      const o = t.closest('[data-o]'); if (o) { mini.choice = mini.choice === o.dataset.o ? '' : o.dataset.o; mini.dirty = true; paint(); return; }
      if (t.closest('.mk-sv')) {
        mini.text = hoverEl.querySelector('textarea').value.trim();
        const input = { mock: data.mock.ref, step: st.id, change: c.id, vote: mini.vote, text: mini.text || (mini.vote === 'yes' ? 'Approved' : 'Rejected'), status: 'open', created: new Date().toISOString() };
        if (mini.choice) input.choice = mini.choice;
        t.disabled = true;
        try { await data.fbDs.append([{ key: `${CFG.key}-${st.id}-${c.id}-${Date.now().toString(36)}`, input }]); await refresh(); closeMini(); }
        catch (err) { t.disabled = false; hoverEl.insertAdjacentHTML('beforeend', `<p style="color:#ff8a80">Not saved: ${esc(err?.message || err)}</p>`); }
      }
    };
  }
  function changeEl(sec, c) {
    const q = CSS.escape(c.id);
    return sec.querySelector(`[data-mk-after="${q}"]`) || [...sec.querySelectorAll(`[data-change="${q}"]`)].find((e) => e.getClientRects().length && !e.classList.contains('mk-off')) || null;
  }
  function flashTo(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('mk-flash'); void el.offsetWidth; el.classList.add('mk-flash');
  }
  let nextIx = 0;
  // pins show only while their change (or the pin) is hovered; the change itself always carries a border
  let hot = '', hotT = 0;
  const setHot = (id) => { clearTimeout(hotT); if (hot === id) return; hot = id; chPins.querySelectorAll('.mk-pin').forEach((p) => p.classList.toggle('mk-quiet', p.dataset.c !== hot && !(mini?.c === p.dataset.c && !hoverEl.hidden))); };
  const coolSoon = () => { clearTimeout(hotT); hotT = setTimeout(() => setHot(''), 350); };
  document.addEventListener('mouseover', (e) => {
    const t = e.target; if (!(t instanceof Element) || t.closest('[data-mockify]')) return;
    const el = t.closest('[data-mk-after],[data-change]');
    const sec = J[cur] && secOf(J[cur]);
    if (!el || !sec || !sec.contains(el)) { if (hot) coolSoon(); return; }
    const id = el.getAttribute('data-mk-after') || el.getAttribute('data-change');
    if (changesOf(J[cur]).some((c) => c.id === id)) setHot(id);
  });
  let pinQueued = false;
  const pinsSoon = () => { if (pinQueued) return; pinQueued = true; requestAnimationFrame(() => { pinQueued = false; drawChanges(); }); };
  addEventListener('scroll', pinsSoon, true); addEventListener('resize', pinsSoon);

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
      const multi = multiApp();
      const delta = (s) => { const up = J[find(s.parent)]; return Object.entries(s.state || {}).filter(([k, v]) => !up || up.state?.[k] !== v).map(([k, v]) => `${k}=${v}`).join(' '); };
      panel.innerHTML = head() + '<h4>Screens</h4>' + J.map((s, i) => {
        const sets = i ? delta(s) : '';
        const label = (isBranch(s) ? '↳ ' : '') + esc(isBranch(s) && s.when ? `${s.when} — ${s.title}` : s.title)
          + (isNew(s) ? ' <span class="stag new" style="margin:0 0 0 4px">NEW</span>' : '') + (sets ? ` <small style="opacity:.7">${esc(sets)}</small>` : '');
        const num = s.num;
        return `<button class="row${isBranch(s) ? ' br' : ''}${i === cur ? ' on' : ''}" data-i="${i}" style="padding-left:${8 + 14 * (s.depth || 0)}px"><span class="num">${num}</span>${label}${(() => { const t = [multi && s.app, whoOf(s).name].filter(Boolean).join(' · '); return t ? `<small>${esc(t)}</small>` : ''; })()}</button>`;
      }).join('') + `<button class="row hints-toggle" style="margin-top:6px">${hints ? '☑' : '☐'} Highlight the next step on each screen</button>`;
      return;
    }
    if (open.startsWith('change:')) {
      panel.classList.remove('wide');
      const st = J[cur], cs = changesOf(st), k = cs.findIndex((c) => c.id === open.slice(7)), c = cs[k];
      if (!c) { open = ''; panel.hidden = true; return; }
      const v = latestVote(st, c) || {}, d = cdraft[st.id + ':' + c.id] || (cdraft[st.id + ':' + c.id] = { vote: v.vote || '', choice: v.choice || '', text: v.vote ? '' : '' });
      const scr = c.mode === 'screen', on = isRev(st, c);
      panel.innerHTML = head() + `<h4>Change ${k + 1} of ${cs.length}</h4><div style="font-weight:700;margin:0 2px 6px">${esc(c.title)}</div>`
        + `<div class="chips">${c.type ? `<span class="chip">${esc(c.type)}</span>` : ''}<span class="chip">${scr ? 'new screen' : 'in place'}</span></div>`
        + (c.note ? `<div class="note">${esc(c.note)}</div>` : '')
        + `<button class="reveal${on ? ' on' : ''}">${scr ? 'Open the suggested screen →' : on ? 'Showing suggested · back to today' : 'Show suggested'}</button>`
        + (c.options && c.options.length ? `<div class="chips">${c.options.map((o) => `<button class="chip opt${d.choice === o ? ' on' : ''}" data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : '')
        + `<div class="vote"><button class="vy${d.vote === 'yes' ? ' on' : ''}" data-vote="yes">Yes</button><button class="vn${d.vote === 'no' ? ' on' : ''}" data-vote="no">No</button></div>`
        + `<textarea class="ctext" placeholder="Comment (optional)"></textarea>`
        + (v.vote ? `<div class="note" style="margin-top:6px">Saved: ${esc(v.vote)}${v.choice ? ' · ' + esc(v.choice) : ''}${v.text && !/^(Yes|No)$/.test(v.text) ? ' — ' + esc(v.text) : ''} (${esc(v.status)})</div>` : '')
        + `<div class="actions"><button class="ico cprev" title="Previous change">‹</button><button class="ico cnext" title="Next change">›</button><button class="save csave"${!data.fbDs || !data.mock ? ' disabled title="Feedback is off here"' : ''}>Save</button></div>`;
      $('.ctext').value = d.text || '';
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
    if (changesOf(s).length) {
      html += `<h4>Changes on this screen</h4>` + changesOf(s).map((c, k) => {
        const v = latestVote(s, c);
        return `<button class="crow" data-c="${esc(c.id)}"><i>${k + 1}</i><span>${esc(c.title)}</span><small class="${v?.vote === 'no' ? 'no' : 'yes'}">${v?.vote === 'no' ? 'rejected' : 'approved'}${v?.choice ? ' · ' + esc(v.choice) : ''}</small></button>`;
      }).join('') + `<h4 style="margin-top:12px">A comment on the whole screen</h4>`;
    }
    if (s.note) html += `<div class="note">${esc(s.note)}</div>`;
    if (s.expect && s.expect.length) html += `<div class="note"><b>Test checks</b>\n${s.expect.map((e) => '✓ ' + esc(e)).join('\n')}</div>`;
    if (!data.fbDs || !data.mock) {
      html += `<div class="msg">${esc(data.error || 'Loading…')}</div>`;
      panel.innerHTML = html; return;
    }
    if (decisions.length) {
      html += `<div class="chips">${decisions.map((d) => `<button class="chip${draft.decision === d.id ? ' on' : ''}" data-dec="${esc(d.id)}" title="${esc(d.question)}">${esc(d.id)} · ${esc(d.question.length > 40 ? d.question.slice(0, 40) + '…' : d.question)}</button>`).join('')}</div>`;
    }
    if (draft.anchor) {
      html += `<div class="anchor">📍 <span>On</span> <b title="${esc(draft.anchor.selector)}">${esc(draft.anchor.label)}</b><button class="ico clear-anchor" title="Not on this element">✕</button></div>`
        + (draft.shot ? `<img class="thumb" src="${draft.shot}" alt="the element">` : '');
    }
    html += `<textarea placeholder="${draft.anchor ? 'What do you want for this element?' : 'What should change on this screen? (or use the picker at the left of the bar to point at an element)'}"></textarea>`
      + (draft.image ? `<img class="thumb" src="${draft.image}" alt="attached image">` : '')
      + `<div class="actions"><button class="attach">📎 ${draft.image ? 'Replace image' : 'Attach image'}</button>`
      + (draft.image ? '<button class="ico clear-img" title="Remove the image">✕</button>' : '')
      + `<button class="save">Save</button></div><input class="file" type="file" accept="image/*" hidden>`;
    const here = stepRows();
    if (here.length) {
      html += `<h4 style="margin-top:14px">Saved on this screen (${here.length})</h4>` + here.map((r) => {
        const i = r.input;
        return `<div class="item" data-key="${esc(r.key)}"><div class="meta">${i.anchor ? `<b>📍 ${esc(i.anchor.label)}</b>` : ''}${i.decision ? `<b>${esc(i.decision)}</b>` : ''}<span>${esc(i.status)}</span><span>${esc((i.created || '').slice(11, 16))}</span>`
          + (i.status === 'open' ? `<button class="del" data-key="${esc(r.key)}" data-v="${esc(r.version || '')}" title="Delete">✕</button>` : '') + `</div>`
          + `<div>${esc(i.text)}</div>${i.element_shot ? `<img class="thumb" src="${i.element_shot}" alt="the element">` : ''}${i.screenshot ? `<img class="thumb" src="${i.screenshot}" alt="">` : ''}</div>`;
      }).join('');
    }
    panel.innerHTML = html;
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
      const forKinds = () => Promise.all(['mockify.mock', 'mockify.feedback']
        .map((kind) => sdk.Dataset.forKind(kind, projectId || undefined)));
      let found;
      try { found = await forKinds(); } catch (e) {
        // After a backend restart the mock project's kinds are not loaded (the repo holds the same namespace):
        // apply the mock project's data_schema folder once, the way `flow schema apply` does, and ask again.
        if (!CFG.schemas) throw e;
        await sdk.apiClient.post('/graph/compute_node/@local/fs-records/index', null,
          { params: { type: 'data_schema', path: CFG.schemas, force: 'true' } });
        found = await forKinds();
      }
      const [[mocksDs], [fbDs]] = found;
      if (!mocksDs || !fbDs) throw new Error('this project has no mocks / mock-feedback dataset (set MOCKIFY.project to the mock project id)');
      Object.assign(data, { sdk, mocksDs, fbDs });
      // Subscribe BEFORE the first read: a page opened before its row is put must still pick it up.
      mocksDs.onRowsChanged(() => loadMock().then(refresh));
      fbDs.onRowsChanged(() => refresh());
      await loadMock();
      await refresh();
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
    // No row yet is a wait, not a failure: the subscription in boot() loads it when it is put.
    if (!row) { data.error = `Waiting for mock row "${CFG.key}" in the mocks dataset…`; render(); return; }
    if (data.error?.startsWith('Waiting for mock row')) data.error = null;
    const changed = row.version !== data.mock?.version;
    data.mock = row;
    // A fast mock is the person's choice, never the builder's: without its reason it is not reviewable.
    if (row.input.mode === 'fast' && !(row.input.fast_reason || '').trim()) {
      throw new Error('fast mock without fast_reason — rebuild it in real mode (SKILL.md §2)');
    }
    if (changed) render();
  });
  // The mock's comments, once: the badge counts the open ones, the panel shows this screen's.
  const refresh = coalesced(async () => {
    if (!data.fbDs || !data.mock) return;
    data.rows = (await data.fbDs.query({ match: { 'input.mock': data.mock.ref }, order_by: { 'input.created': 'asc' } })).rows;
    render();
  });
  function finishBoot() {
    if (!mock.go(location.hash.slice(1), 'hash')) paint(false);   // a deep link, else the root
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
      setPanel('');   // saved: back to the clean bar; the bubble and Execute (n) show it
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
      ...(J.some((x) => changesOf(x).length) ? [`Proposed changes: ${J.reduce((n, x) => n + changesOf(x).length, 0)}. A change with no row below is APPROVED (the default); act on every REJECTED one and every comment.`] : []),
      ...(m?.input.folder || CFG.folder ? [`Mock folder: \`${m?.input.folder || CFG.folder}\``] : []), ''];
    steps.forEach((s) => {
      out.push(`## ${find(s.id) + 1}. ${s.title} — \`${s.id}\` (${[s.app, whoOf(s).label.slice(3)].filter(Boolean).join(' · ')})`, '');
      byStep[s.id].forEach((r) => {
        const i = r.input;
        const ch = i.change && changesOf(s).find((c) => c.id === i.change);
        const where = [ch && `**change ${changesOf(s).indexOf(ch) + 1} · ${ch.title}**${i.vote ? ` — **${i.vote.toUpperCase()}**` : ''}${i.choice ? ` (picked: ${i.choice})` : ''}`,
          i.decision && `**${i.decision}**`, i.anchor && `on "${i.anchor.label}" \`${i.anchor.selector}\``].filter(Boolean).join(' · ');
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
    // submit = type the line, then a discrete Enter: a queued line can land in a terminal's input box unsent.
    await proc.submit(noteFor(rows, name, `${dir.abs_path}/${name}`));
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
      // Back to the session's tab: it now has the comments to act on. The Submitted panel above is what a
      // page with no host (opened on its own) keeps showing.
      data.sdk.navigateHost?.({ typeid: `agentic_process-${m.input.session}` });
    } catch (err) {
      setPanel('send');
      panel.insertAdjacentHTML('beforeend', `<div class="msg">Not sent: ${esc(err?.message || err)}</div>`);
    } finally { render(); }
  }

  // ── controls ──
  $('.back').onclick = () => mock.back();
  $('.next').onclick = () => mock.next();
  $('.restart').onclick = () => { setPanel(''); mock.reset(); };
  $('.steps').onclick = () => setPanel(open === 'steps' ? '' : 'steps');
  // the counter walks the screen's changes: each click scrolls to the next one and flashes it
  $('.cnt').onclick = () => { const st = J[cur], sec = secOf(st), cs = changesOf(st); if (!sec || !cs.length) return;
    nextIx = nextIx % cs.length; flashTo(changeEl(sec, cs[nextIx])); nextIx++; };
  const setView = (v) => { view = v; store.set('view', v); document.documentElement.classList.toggle('mk-clean', v !== 'diff'); J.forEach((st) => changesOf(st).forEach((c) => setRev(st, c, true))); render(); };
  $('.sw-d').onclick = () => setView('diff');
  $('.sw-t').onclick = () => setView('today');
  $('.sw-a').onclick = () => setView('after');
  async function saveChange(st, c) {
    const d = cdraft[st.id + ':' + c.id] || {};
    d.text = ($('.ctext')?.value || '').trim();
    if (!d.vote && !d.text && !d.choice) return;
    const input = { mock: data.mock.ref, step: st.id, change: c.id, text: d.text || (d.vote === 'yes' ? 'Yes' : d.vote === 'no' ? 'No' : d.choice || ''),
      status: 'open', created: new Date().toISOString() };
    if (d.vote) input.vote = d.vote;
    if (d.choice) input.choice = d.choice;
    $('.csave').disabled = true;
    try { await data.fbDs.append([{ key: `${CFG.key}-${st.id}-${c.id}-${Date.now().toString(36)}`, input }]); delete cdraft[st.id + ':' + c.id]; await refresh(); renderPanel(); }
    catch (err) { panel.insertAdjacentHTML('beforeend', `<div class="msg">Not saved: ${esc(err?.message || err)}</div>`); $('.csave').disabled = false; }
  }
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
    const crow = t.closest('.crow'); if (crow) { const st = J[cur], k = changesOf(st).findIndex((c) => c.id === crow.dataset.c); setPanel(''); openMini(st, changesOf(st)[k], k); shownAt = Date.now() + 2500; return; }
    if (open.startsWith('change:')) {
      const st = J[cur], cs = changesOf(st), k = cs.findIndex((c) => c.id === open.slice(7)), c = cs[k], key = st.id + ':' + (c && c.id);
      if (c) {
        const d = cdraft[key] || (cdraft[key] = {});
        if (t.closest('.ctext')) return;
        d.text = $('.ctext')?.value || d.text;
        if (t.closest('.reveal')) { if (c.mode === 'screen') { setPanel(''); window.mockifyGo(c.to); } else { setRev(st, c, !isRev(st, c)); renderPanel(); drawChanges(); } return; }
        const vb = t.closest('[data-vote]'); if (vb) { d.vote = d.vote === vb.dataset.vote ? '' : vb.dataset.vote; renderPanel(); return; }
        const ob = t.closest('.opt'); if (ob) { d.choice = d.choice === ob.dataset.o ? '' : ob.dataset.o; renderPanel(); return; }
        if (t.closest('.cprev')) { setPanel('change:' + cs[(k - 1 + cs.length) % cs.length].id); return; }
        if (t.closest('.cnext')) { setPanel('change:' + cs[(k + 1) % cs.length].id); return; }
        if (t.closest('.csave')) { saveChange(st, c); return; }
      }
    }
    const tool = t.closest('.ptool');
    if (tool) { setPanel(tool.dataset.panel); return; }
    if (t.closest('.send-now')) { submitAll(); return; }
    if (t.closest('.save-now')) {
      const b = t.closest('.save-now'); b.disabled = true;
      sessionOf().then((proc) => {
        if (!proc) throw new Error('the mock row names no session');
        return proc.submit(`Save mock "${CFG.key}" to the repo: the person pressed Save — run the mockify skill's scripts/mock_project.py save ${data.mock.input.repo} ${CFG.key} (SKILL.md "Save to repo").`);
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
    if (row) { setPanel(''); mock.go(J[+row.dataset.i]?.id); return; }
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

  // Drag by the grip; the position is kept for the session and stays on screen.
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
  mock.onChange((_m, how) => paint(how !== 'hash'));   // a move the address bar made is not pushed back onto it
  const fromHash = () => { const id = location.hash.slice(1); if (id !== J[cur]?.id) mock.go(id, 'hash'); };   // an unknown id moves nothing
  addEventListener('hashchange', fromHash);
  addEventListener('popstate', fromHash);

  window.mockifyGo = (id) => { if (!mock.go(id)) console.warn(`mockify: no screen "${id}" in the mock tree`); };
  render();
  boot();
  addEventListener('load', contrast);
})();
