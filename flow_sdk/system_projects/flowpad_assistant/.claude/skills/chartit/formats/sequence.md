# sequence — who calls whom, in order

A chart type of the chartit skill: read `../SKILL.md` first — it sets the folder, the shared rules and how a
chart is indexed, linked, shown and verified. This file adds only what a `sequence` chart needs.

The file: `chart.json`, checked against `chartit.sequence` (`DM check`, data-management skill):

```json
{"participants": [{"id": "app", "label": "Acme App", "sublabel": "Flutter app", "icon": "lucide.app-window", "note": "app/frontend"}],
 "messages": [
   {"id": "m1", "from": "app", "to": "tenant", "label": "POST …/oauth/init", "note": "locations-routes.js:182"},
   {"id": "m2", "from": "tenant", "to": "app", "label": "{redirectUrl}", "style": "dashed"},
   {"id": "m3", "from": "conn", "to": "conn", "label": "buildAuthorizeUrl()"},
   {"id": "m4", "from": "conn", "to": "vauth", "label": "Token refresh", "ref": "token-refresh", "returns": "fresh access token"}]}
```

- A participant may take `ref: "<chart name>"` (any format — e.g. that system's C4 chart): drawn as
  **Open ↗** under its card, with the same `flow dep add` link as any `ref` (`SKILL.md` §3).
- Participants left to right, initiator first. Every card has a `label`, a `sublabel` (what it is: a
  product, a host, a service — `api.sonos.com`, `Cloud Run worker`) and an `icon`.
- `icon` follows the base's icon rules (`SKILL.md` §2).
- Messages top to bottom, ids `m1, m2…`; `from == to` is a self-call;
  `style: "dashed"` for a reply. Labels short (a route or a verb); detail goes in `note` (hover).
- Copy names exactly as the source has them (typos included — ask before fixing).
- Where the facts come from code, cite `file:line` in `note`.

**Sequence sets: never draw a repeated flow twice.** List every flow first; a run of steps that
recurs (token refresh, a proxy hop, "select sources") is its own chart, and each place it happens is
ONE message with `ref: "<that chart's name>"` — a SUB-FLOW block with **Open ↗**. Its output enters
the calling flow through `returns: "<what comes back>"`.

Keep a chart under ~25 messages and ≤ 8 participants — past that, cut sub-flows. Participant colours
are the base's categorical slots in fixed order (blue, orange, aqua, violet; a 5th+ is neutral), never
cycled; replies are dashed.
