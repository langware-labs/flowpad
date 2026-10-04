# Drive and debug

> Ground rules (inline by design): start on the agent profile — it holds none
> of the user's accounts — and attach to the user's own Chrome only when they
> ask, for that session. Find a Chrome window by its pid: several Chromes share
> one app name, so a lookup by name lands on an arbitrary one. Never type into
> whatever app is in front — a focus request can fail silently, and keys that
> land in a chat or form can send something that cannot be taken back; ask the
> user to switch windows instead.

Every tool runs as `$S run <tool> <args…>` (`S=<this skill's folder>/scripts/browser.sh`);
the script adds this instance's session. `$S run --help` lists all tools, and
`$S run <tool> --help` shows one tool's arguments.

## The loop: snapshot → act on uid → re-snapshot

```bash
$S run new_page "http://127.0.0.1:3000/"     # prints the page list; note the pageId
$S run take_snapshot <pageId>               # accessibility tree, each element has a uid
$S run click <pageId> <uid>
$S run fill <pageId> <uid> "text"
$S run take_snapshot <pageId>               # the page changed: old uids are stale
```

Act on uids from the latest snapshot. They are what a user can see and reach,
so a click that works by uid works for the user too; a click made with
`evaluate_script` bypasses visibility, overlays and disabled states, and can
pass on a page a person cannot use. Keep `evaluate_script` for reading state.

Take a screenshot to confirm a visual result, not to find elements — the
snapshot is cheaper and exact. Save it to a file and open that file to see it:
`take_screenshot <pageId> --filePath /tmp/shot.png`.

## Debug: evidence before edits

```bash
$S run list_console_messages <pageId>
$S run get_console_message <pageId> <msgid>    # full text + stack
$S run list_network_requests <pageId>
$S run get_network_request <pageId> --reqid <reqid>   # status, headers, body
```

Name every bug with its evidence — the console text, or the request and its
status — before changing code. After a fix, reload
(`navigate_page <pageId> --type reload`), repeat the flow, and re-read console
and network: a fix is verified when the flow works AND both lists are clean.

## Save a verified flow as a replay script

A flow you verified by hand is worth keeping: write it as a script that reruns
with no model in the loop. Use playwright-core against the same browser, in a
new page of its own:

```js
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PORT}`);
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:3000/');
  for (const add of await page.getByRole('button', { name: 'Add' }).all()) await add.click();
  const total = await page.locator('#total').textContent();
  if (total !== '32') throw new Error(`total ${total}`);
  console.log('PASS');
} catch (e) { console.log('FAIL:', e.message); process.exitCode = 1; }
finally {
  await page.close();
  await browser.close();   // over CDP this only disconnects; Chrome keeps running
}
```

- `PORT` comes from `$S status`; replay works on the agent profile only.
  Install the library where the script lives: `npm i playwright-core` (no
  browser download — it drives the Chrome that is already running).
- Locate by role and name (`getByRole`, `getByLabel`), as the user sees the
  page; positional selectors (`buttons[0]`) break on the next layout change.
- Prove the script can fail: run it once against the broken state (or a
  stashed copy) and see `FAIL`, then against the fix and see `PASS`. A script
  that never failed has not shown it tests anything.
- Save it beside the app it tests and tell the user the command to rerun it.
