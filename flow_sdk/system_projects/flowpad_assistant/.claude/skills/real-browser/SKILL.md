---
id: 624500c5-1681-4ffb-b2b2-127b728f668a
name: real-browser
description: Gives you a real, visible browser — the user's own installed Chrome or Edge — to
  drive and debug through Chrome DevTools (clicks, forms, console, network requests,
  performance), on request. Use when the user asks you to "use a browser", "open it
  in Chrome", "click through it", "check it in a real browser", "see what the console
  says", "debug why the page breaks", "log in and do X on <site>", "use my Chrome /
  my logged-in session", when iterating on a dev server with hot reload (HMR), or when
  an app you built must be verified interactively and a headless sweep is not enough.
  Works on macOS, Linux and Windows (Chrome, or Edge when Chrome is absent). Also turns a flow you verified into a replayable
  script. NOT for a headless pass/fail sweep of pages (web-tester), showing a page
  in the Flowpad display (flowpad-navigation), or building the app (web-app-builder).
tags:
- browser
- chrome
- devtools
- debugging
allowed-tools:
- Bash
- Read
- Write
- Edit
---

# Real browser

> Ground rules (inline by design): start on the agent profile — it holds none
> of the user's accounts — and attach to the user's own Chrome only when they
> ask, for that session. Find a Chrome window by its pid: several Chromes share
> one app name, so a lookup by name lands on an arbitrary one. Never type into
> whatever app is in front — a focus request can fail silently, and keys that
> land in a chat or form can send something that cannot be taken back; ask the
> user to switch windows instead.

Everything runs through `scripts/browser.mjs` in this skill's folder; below,
`browser` means `node <this skill's folder>/scripts/browser.mjs`. It is plain
Node — the chrome-devtools CLI needs Node anyway — so it runs the same from
bash, Git Bash and PowerShell on macOS, Linux and Windows. It keeps one browser
per Flowpad instance and one chrome-devtools session for it, so calls from
several agents land on the same browser instead of spawning more.

Its tools come from Flowpad's setup wizard. When `node` is not found, or the
script exits `NEEDS_SETUP` (8) or `NO_BROWSER` (2), run
`flow wizard run browser-setup`: it checks Node.js, the chrome-devtools CLI and
a browser, and asks the user before installing whatever is missing. Then run
the script again.

| When you need to…                                                         | Load              |
| ------------------------------------------------------------------------- | ----------------- |
| start, reuse, bring forward or stop the browser on the agent profile      | `setup.md`        |
| act inside the user's own logged-in Chrome ("use my Chrome / my session") | `real-profile.md` |
| click, fill, read console/network, debug a page, or save a replay script  | `drive.md`        |
