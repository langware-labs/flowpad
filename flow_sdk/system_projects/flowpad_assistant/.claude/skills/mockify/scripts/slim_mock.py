"""Make a built mock small: keep only the CSS rules some screen uses, and inline each repeated file once.

Usage:
  uv run --with playwright python -I slim_mock.py <mock-dir>/index.html

Captures carry the app's whole stylesheet (a dev build is hundreds of KB) and the same icon as a data: URI on
every screen. This loads the page headless, reveals every <template> (the suggested versions of changes), and
drops each style rule whose selector matches nothing, at-rules (fonts, keyframes, layers, properties) kept.
A data: URI used more than once becomes a CSS variable (in url()) or a data-mk-asset key (in src/href),
defined once. Rewrites index.html in place; run it after build_mock.py, before validate_mock.py.
"""

import hashlib
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

PRUNE = r"""() => {
  // the suggested versions live in <template>s: put copies in the page so their selectors count as used
  const extra = document.createElement('div'); extra.hidden = true;
  document.querySelectorAll('template').forEach((t) => extra.append(t.content.cloneNode(true)));
  document.body.append(extra);
  const used = (sel) => { try {
      const bare = sel.replace(/(?<!\\)::?[a-z-]+(\([^)]*\))?/gi, (m) => /^:(is|where|not|has)\(/i.test(m) ? m : '');
      return !bare.trim() || !!document.querySelector(bare);
    } catch { return true; } };
  const walk = (rules) => [...rules].map((r) => {
    if (r instanceof CSSStyleRule) return used(r.selectorText) ? r.cssText : '';
    if (r.cssRules && (r instanceof CSSMediaRule || r instanceof CSSSupportsRule || r.constructor.name === 'CSSContainerRule' || r.constructor.name === 'CSSLayerBlockRule')) {
      const inner = walk(r.cssRules).join('');
      return inner ? r.cssText.slice(0, r.cssText.indexOf('{') + 1) + inner + '}' : '';
    }
    return r.cssText;   // @font-face, @keyframes, @property, @import, @layer order
  });
  const out = [...document.querySelectorAll('style[data-mk-i]')].map((s) => (s.sheet ? walk(s.sheet.cssRules).join('\n') : s.textContent));
  extra.remove();
  return out;
}"""


def dedupe_assets(html: str) -> str:
    uris = re.findall(r"data:[a-z+/.-]+;base64,[A-Za-z0-9+/=]+", html)
    counts: dict[str, int] = {}
    for u in uris:
        counts[u] = counts.get(u, 0) + 1
    shared = {u: "a" + hashlib.sha1(u.encode()).hexdigest()[:10] for u, n in counts.items() if n > 1 and len(u) > 200}
    if not shared:
        return html
    for u, k in shared.items():
        html = html.replace(f"url({u})", f"var(--mk-{k})").replace(f'url("{u}")', f"var(--mk-{k})")
        html = html.replace(f'url(&quot;{u}&quot;)', f"var(--mk-{k})")
        html = re.sub(r'\b(src|href)="' + re.escape(u) + '"', rf'\1="" data-mk-asset="{k}" data-mk-attr="\1"', html)
    root = ":root{" + "".join(f'--mk-{k}:url("{u}");' for u, k in shared.items()) + "}"
    table = "{" + ",".join(f'"{k}":"{u}"' for u, k in shared.items()) + "}"
    # the journey bar clones screens and templates: fill assets in them too, as they appear
    fill = (f"<script>(() => {{ const A = {table}; const put = (r) => r.querySelectorAll('[data-mk-asset]').forEach((e) => "
            "e.setAttribute(e.dataset.mkAttr, A[e.dataset.mkAsset]));"
            " put(document); document.querySelectorAll('template').forEach((t) => put(t.content));"
            " new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.querySelectorAll && put(n))))"
            ".observe(document.body, {childList: true, subtree: true}); })();</script>")
    html = html.replace("</head>", f"<style>{root}</style>\n</head>", 1)
    return html.replace("<body>", "<body>\n" + fill, 1)


def main() -> None:
    page_path = pathlib.Path(sys.argv[1]).resolve()
    html = page_path.read_text()
    before = len(html)
    head, sep, rest = html.partition("</head>")
    blocks = list(re.finditer(r"<style\b[^>]*>.*?</style>", head, flags=re.S))
    # number the built page's own blocks: the page adds styles of its own at runtime (the journey bar)
    marked = head
    for i, m in reversed(list(enumerate(blocks))):
        marked = marked[: m.start()] + f'<style data-mk-i="{i}"' + marked[m.start() + 6:]
    probe = page_path.with_name(".slim-probe.html")
    probe.write_text(marked + sep + rest)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(probe.as_uri())
        kept = page.evaluate(PRUNE)
        browser.close()
    probe.unlink()
    if len(blocks) != len(kept):
        sys.exit(f"slim_mock: {len(blocks)} <style> blocks in the head, the page reported {len(kept)}")
    for m, css in reversed(list(zip(blocks, kept))):
        head = head[: m.start()] + (f"<style>{css}</style>" if css.strip() else "") + head[m.end():]
    html = dedupe_assets(head + sep + rest)
    page_path.write_text(html)
    print(f"slim_mock: {before:,} -> {len(html):,} bytes")


if __name__ == "__main__":
    main()
