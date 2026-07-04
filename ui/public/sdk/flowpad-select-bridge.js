/*
 * Flowpad select bridge — injected into the Vibe display's proxied web app
 * (see AgenticProcess.app_proxy). Runs INSIDE the guest page. Lets the Vibe
 * display turn on "select mode", highlights the hovered element, and on click
 * posts the picked element's description to the parent (the Vibe workspace).
 *
 * Protocol (postMessage, JSON-ish):
 *   parent -> guest : { source:'flowpad', type:'select-mode', on:boolean }
 *   guest  -> parent: { source:'flowpad', type:'selected', payload:{...} }
 * The guest is same-origin with this script (both served through the backend
 * proxy), so it reads its own DOM directly; only the parent hop uses postMessage.
 */
(function () {
  if (window.__flowpadSelectBridge) return;
  window.__flowpadSelectBridge = true;

  var active = false;
  var overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-flowpad-overlay', '1');
    var s = overlay.style;
    s.position = 'fixed';
    s.zIndex = '2147483647';
    s.pointerEvents = 'none';
    s.border = '2px solid #6d5cff';
    s.background = 'rgba(109,92,255,0.12)';
    s.borderRadius = '3px';
    s.transition = 'all 40ms ease-out';
    s.display = 'none';
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function moveOverlay(el) {
    var o = ensureOverlay();
    var r = el.getBoundingClientRect();
    o.style.display = 'block';
    o.style.left = r.left + 'px';
    o.style.top = r.top + 'px';
    o.style.width = r.width + 'px';
    o.style.height = r.height + 'px';
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  // A stable-ish CSS path (nth-of-type per level), capped in depth.
  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6 && node !== document.body) {
      var sel = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(sel + '#' + CSS.escape(node.id));
        break;
      }
      var parent = node.parentNode;
      if (parent) {
        var same = [];
        var kids = parent.children;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].tagName === node.tagName) same.push(kids[i]);
        }
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    var text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    var html = el.outerHTML || '';
    return {
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: text.length > 200 ? text.slice(0, 200) + '…' : text,
      html: html.length > 500 ? html.slice(0, 500) + '…' : html,
    };
  }

  // The overlay has pointer-events:none, so e.target is always the real element
  // under the cursor — no need to stash it between move and click.
  function onMove(e) {
    if (!active) return;
    var el = e.target;
    if (!el || el === overlay || el.nodeType !== 1) return;
    moveOverlay(el);
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    try {
      window.parent.postMessage({ source: 'flowpad', type: 'selected', payload: describe(el) }, '*');
    } catch (err) { /* ignore */ }
    setActive(false);
  }

  function onKey(e) {
    if (active && e.key === 'Escape') setActive(false);
  }

  function setActive(on) {
    if (on === active) return;
    active = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (on) {
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      hideOverlay();
      // Tell the parent the mode ended (e.g. Esc / after pick) so its toggle resets.
      try { window.parent.postMessage({ source: 'flowpad', type: 'select-mode-ended' }, '*'); } catch (err) { /* ignore */ }
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'flowpad') return;
    if (d.type === 'select-mode') setActive(!!d.on);
  });
})();
