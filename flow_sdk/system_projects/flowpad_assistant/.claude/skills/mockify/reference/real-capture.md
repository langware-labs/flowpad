# Real mode — build the mock out of the running app

Use it when the new screens extend an app that runs here (Flowpad, or the user's own app). A hand-drawn
copy of a real product never looks like it; the product's own DOM and CSS do.

## 1. A test instance, never the person's real one

Flowpad: `scripts/instance_ctl.sh launch mock-1` from the repo (own ports, own DB), or an instance that
`ls ~/.flow/instances/*/server.json` shows running and that is not `prod` (never port 9007). Anything you add
to reach a state (a test source, a fake task) goes there — and is named in your reply. The user's own app:
its dev server.

## 2. Drive it to each base screen, in a real browser

Chrome tools (or the `real-browser` skill), in **your own tab** — others may share the browser. Reach the real
states the journey starts from (e.g. add a test source to get its genuine "Setup required" strip). **Write
down what the real app does on the way** (a dialog that never opens, a "completed" that is not): the user
wants that feedback too. After every reload take a NEW screenshot (or `find` a ref) before clicking — a
stale screenshot after the layout and webfont settle is the usual reason a click "does nothing".

## 3. Capture

Start the receiver; it binds 127.0.0.1 on a port the OS picks and prints it:

```bash
python3 -I <skill>/scripts/capture_recv.py <mock-dir>/capture > <mock-dir>/recv.log 2>&1 &   # keep the PID
sleep 1; PORT=$(awk '/^PORT/{print $2}' <mock-dir>/recv.log)
```

In the page (javascript tool), define once, then call per screen. Send everything through the receiver —
the javascript tool blocks results that contain URLs or style text, so do not try to *return* them:

```js
window.__cap = async (name) => {
  const styles = [...document.querySelectorAll('style')].map((s) => s.outerHTML).join('\n');
  const html = '<!--styles-->\n' + styles + '\n<!--body-->\n' + document.body.innerHTML;
  await fetch('http://127.0.0.1:PORT/' + name, { method: 'POST', body: html });
  return html.length;
};
window.__info = () => fetch('http://127.0.0.1:PORT/info.json', { method: 'POST', body: JSON.stringify({
  htmlAttrs: [...document.documentElement.attributes].map((a) => `${a.name}="${a.value}"`).join(' '),
  bodyFont: getComputedStyle(document.body).fontFamily,
  stylesheets: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href),
  fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`),
}) });
await __info(); await __cap('home.html');
```

`info.json` tells you what the `<html>` carries and where the font comes from — both change the look and
neither is in the body. Flowpad today: `data-view="vibe"`, `class="dark"`, an inline `--primary`, and the
Plus Jakarta Sans webfont from a Google Fonts `<link>` (pass that link to `build_mock.py --head`). Missing
any of these is the difference between "close" and "the same".

## 4. Assets

Copy **the stylesheet the page links** (from `info.json` → `stylesheets`; Flowpad: the one
`static/assets/index-*.css`, not the lazy chunks) to `<mock-dir>/app.css`, and the asset folders the
captures reference (Flowpad: `flow_sdk/server/icons/` → `icons/`, PNGs from `static/assets/` → `assets/`).
That stylesheet is the BUILT one and can lag the component source you read — if a class from source is
missing (step 5), the build is older than the source; say so instead of guessing.
`build_mock.py --origin http://localhost:<app port>` makes captured absolute URLs relative (`/assets`,
`/icons`); anything else absolute (an `/api/...` image) stays pointing at the app — avoid cloning it.
The builder strips the app's own `<script>` tags from captures so its theme switcher cannot flip the mock.

## 5. Build new screens from real parts

The states script draws one step per load from `location.hash` (`mockGo` sets the hash and reloads):

- **Clone, don't draw.** A new tile = a real tile cloned with icon and label swapped; a new strip = the
  captured strip with its text changed; new list rows = a real row cloned (pick one without extras such
  as a count you would have to clear).
- **Mark the way forward** (`data-next`, SKILL.md §4) on the real controls — the cloned tile, the dialog's
  primary button, Cancel / Finish later — AFTER cloning: a clone carries no listeners.
- **Dialogs:** select `[role=dialog][data-state=open]` (a capture also holds hidden dialogs — a floating
  chat, menus). Take its overlay from the ORIGINAL node's `previousElementSibling` before cloning — a
  clone is detached and has no siblings. Append both to `body`.
- **New UI uses the component's own classes**, copied from its source file (a setup tree row, a question
  box, a button variant). Check them before use — the CSS is minified and escapes `. / : [`, so grep lies:
  `python3 -I <skill>/scripts/check_classes.py app.css "mt-0.5 bg-red-500/15 …"`.
- **A state the live app cannot reach** (a component that never rendered for you): build it from the
  component source and say "built from source, not compared live" for that step in your reply.
- Decisions: `build_mock.py` outlines `[data-decision]` on screen; in real mode only the current step's DOM
  exists, so also write each open decision into its step's `note`.

Assemble. The command is long and you will rerun it — keep it in `<mock-dir>/build.sh`:

```bash
python3 -I <skill>/scripts/build_mock.py <mock-dir> --base capture/home.html \
  --template t-dialog=capture/dialog.html --states states.js --key <mock slug> --project <mock project id> \
  --origin http://localhost:<app port> --html-attrs '<htmlAttrs from info.json>' \
  --head '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=…">'
```

## 6. Compare side by side

The mock folder is a Flowpad web app (`build_mock.py` writes its `webapp.json`): `flow app serve` it, as
SKILL.md §5 says — the journey bar needs the SDK to read the mock row and save feedback. Open it next to the
live app; check font,
spacing, colours, icons, every step. For a quick look before it is served, a bare static server still
navigates (feedback off):

```bash
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory <mock-dir> &   # keep the PID; open http://127.0.0.1:$PORT
```

| symptom | cause |
|---|---|
| right layout, wrong font / square checkboxes | `<html>` attributes or the webfont not copied (`info.json`) |
| change not visible after rebuild | hash-only navigation does not reload — load `?v=<n>#<id>` |
| a click "does nothing" | stale screenshot — re-screenshot after each reload, or click a `find` ref |
| a dialog step is blank | overlay taken from a clone, or the wrong `[role=dialog]` |
| a section lost its header row | you replaced the parent; remove only the rows |
| icons blank | served from `file://`, or a URL still points at the app's origin |
| a class has no effect | not in the built CSS — `check_classes.py` |
| two mocks answer on one port | servers not bound to 127.0.0.1; always open `127.0.0.1:<port>` |

## 7. Clean up

Stop the receiver and the static server by PID. Name any test data you added to the instance, and report
what the real app did wrong along the way. The mock lives in the session scratchpad — never committed.
