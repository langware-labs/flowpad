# Real mode — build the mock out of the running app

Use it when the new screens extend an app whose code is here — any app, any stack. A hand-drawn copy of a
real product never looks like it; the product's own DOM and CSS do. This skill is generic: nothing below
assumes a particular product.

## 1. Run the app yourself, in its own dev / UI-only mode

**You start the app.** From its repo, run the UI the way its developers do — its dev server (`npm run dev`,
`vite`, `next dev`, `flutter run -d web-server`, …), or a UI-only / mock-backend mode when it has one
(storybook, MSW, a fixture or demo flag). Read its README / `package.json` scripts to find it. Your own
ports, your own process; stop it when done.

**Never touch the person's real running app or its data.** Do not attach to a production or personal
instance, do not copy its database or data folders, do not sign in as the person. If a screen needs
data, seed it the app's own way (fixtures, seed script, the UI itself) or fill it in the capture — and
name what you added in your reply. If the app cannot run here at all, STOP and ask (fast mode needs
the person's words).

## 2. Drive it to EVERY screen of the journey, in a real browser

Chrome tools (or the `real-browser` skill), in **your own tab** — others may share the browser. Reach the real
state of each step whose `source` is `capture` (a dialog open, a menu dropped, a toast showing) (e.g. add a test source to get its genuine "Setup required" strip). **Write
down what the real app does on the way** (a dialog that never opens, a "completed" that is not): the user
wants that feedback too. After every reload take a NEW screenshot (or `find` a ref) before clicking — a
stale screenshot after the layout and webfont settle is the usual reason a click "does nothing".

### Hard states — recipes (none of them needs an agent)

- **A state that needs the person's own content** (their names, their records): seed look-alike data in
  your dev run, or edit the text in the capture. Never copy their real data to get it.
- **A deep state** (a menu inside a dialog inside a page): reach it by URL / route when the app has one,
  else click through; a state the dev run cannot reach is a `built` step (§5).
- **Part of the screen is a cross-origin `<iframe>`**: the shell capture does NOT contain it. Open the iframe's `src` in its own tab, inline its
  linked stylesheets (`fetch` each `link[rel=stylesheet]`), capture it, save it as `app.html` in the mock,
  and in the states script move the iframe into the display's content slot with `src="app.html"`.

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
  viewport: { w: innerWidth, h: innerHeight },
}) });
await __info(); await __cap('home.html');   // then drive to the next step and __cap('<step id>.html'), every step
```

One capture per step, named by its step id. A step you skip has no screen, and the build stops on it.

`info.json` tells you what the `<html>` carries and where the font comes from — both change the look and
neither is in the body (a theme class, a `data-*` attribute, inline CSS variables, a webfont `<link>` —
pass that link to `build_mock.py --head`). Missing any of these is the difference between "close" and "the same".

## 4. Assets

Copy **the stylesheet the page links** (from `info.json` → `stylesheets`; the main bundle, not lazy chunks) to `<mock-dir>/app.css`, and the asset folders the
captures reference (icons, images — under the same app paths).
That stylesheet is the BUILT one and can lag the component source you read — if a class from source is
missing (step 5), the build is older than the source; say so instead of guessing.
`build_mock.py --origin http://localhost:<app port>` makes captured absolute URLs relative (`/assets`,
`/icons`); anything else absolute (an `/api/...` image) stays pointing at the app — avoid cloning it.
The builder strips the app's own `<script>` tags from captures so its theme switcher cannot flip the mock.

## 5. Screens the live app cannot reach (`source: built`), and assembling

- **Start from the nearest capture**, copy it to `capture/<step id>.html`, and edit that file per the step's
  scenario — the whole screen stays (top bar, rail, status bar), only the discussed part changes.
- **Clone, don't draw.** A new tile = a real tile cloned with icon and label swapped; a new strip = the
  captured strip with its text changed; new rows = a real row cloned.
- **Dialogs:** take `[role=dialog][data-state=open]` and its overlay (the ORIGINAL node's
  `previousElementSibling`) from a capture where it is open; a capture also holds hidden dialogs.
- **New UI uses the component's own classes**, copied from its source file. Check them — the CSS is minified
  and escapes `. / : [`, so grep lies: `python3 -I <skill>/scripts/check_classes.py app.css "mt-0.5 …"`.
- Say "built from source, not compared live" for such a step in your reply.
- **Mark the way forward** (`data-next`) on the planned controls in each capture file.
- A tiny per-screen tweak (one label) may go in `--states`: `window.mockStates = {<id>: (screen, need) => {
  need('[data-testid=x]').textContent = '…'; }}`. `need` throws when the element is missing and the screen
  shows a red banner — never a silently unchanged screen. Anything bigger is its own edited capture.

Assemble. Keep the command in `<mock-dir>/build.sh` — you will rerun it:

```bash
python3 -I <skill>/scripts/build_mock.py <mock-dir> --row row.json --key <mock slug> --project <mock project id> \
  --step home=capture/home.html --step pick=capture/pick.html --step denied=capture/denied.html \
  --origin http://localhost:<app port> --html-attrs '<htmlAttrs from info.json>' --width <viewport.w from info.json> \
  --head '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=…">'
```

**Always pass `--width`.** The mock opens in the Flowpad display, about half the capture window. Without
it the captured layout reflows into the narrow frame: tabs shrink to bare icons, popovers land off screen,
and the reviewer sees an empty dark page. With it every screen keeps its captured layout, zoomed to fit.

A file a screen shows that is not in `<mock-dir>` stays a link and the validator reports it missing — copy
it in (under its app path, e.g. `assets/x.png`) and rebuild.

## 6. Compare side by side

The mock folder is a Flowpad web app (`build_mock.py` writes its `webapp.json`): `flow app serve` it, as
SKILL.md Phase 3 says — the journey bar needs the SDK to read the mock row and save feedback. Open it next to the
live app; check font,
spacing, colours, icons, every step. For a quick look before it is served, a bare static server still
navigates (feedback off):

```bash
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory <mock-dir> &   # keep the PID; open http://127.0.0.1:$PORT
```

| symptom | cause |
|---|---|
| right layout, wrong font / square checkboxes | `<html>` attributes or the webfont not copied (`info.json`) |
| validator: "same screen as …" | that step has no capture of its own — capture it (or edit a copy per its scenario) |
| change not visible after rebuild | the browser cached the page — load `?v=<n>#<id>` |
| a click shows "Not part of this mock" | the control has no `data-next` — add it if the plan says it moves on |
| a click "does nothing" | stale screenshot — re-screenshot after each reload, or click a `find` ref |
| a dialog step is blank | overlay taken from a clone, or the wrong `[role=dialog]` |
| a red banner on a screen | a `--states` tweak's `need(...)` missed — fix the selector or edit the capture |
| a section lost its header row | you replaced the parent; remove only the rows |
| icons blank | not copied into `<mock-dir>` under their app path (the validator lists them) |
| a class has no effect | not in the built CSS — `check_classes.py` |
| two mocks answer on one port | servers not bound to 127.0.0.1; always open `127.0.0.1:<port>` |

## 7. Clean up

Stop the receiver and the static server by PID. Stop the dev server you started. Name any test data you seeded, and report
what the real app did wrong along the way. The mock lives in the session scratchpad — never committed.
