# architecture — the real deployment in one picture

A chart type of the chartit skill: read `../SKILL.md` first — it sets the folder, the shared rules and how a
chart is indexed, linked, shown and verified. This file adds only what a `architecture` chart needs.

The file: `architecture.json`, checked against `chartit.architecture`. Start from
`templates/architecture/example.architecture.json`; the look is fixed by the editor
(`templates/architecture/style.md`) — the file holds facts only.

```json
{"title": "Spora — services and databases",
 "groups": [
   {"id": "tenant", "label": "PER TENANT", "sublabel": "prod · cloudtest · local", "tiers": [
     {"id": "svc", "label": "Services", "parts": [
       {"id": "tapi", "label": "tenant-api", "sublabel": "Node · Cloud Run", "role": "service", "step": 1},
       {"id": "chat", "label": "chat-service", "sublabel": "Python · Agent SDK", "role": "service", "ref": "chat-service-inside"}]},
     {"id": "db", "label": "Firestore · tenant database", "parts": [
       {"id": "t3", "label": "Chat", "sublabel": "chats · messages", "role": "db", "step": 2}]}]},
   {"id": "outside", "label": "OUTSIDE", "parts": [
     {"id": "llm", "label": "Claude / OpenRouter", "role": "external"}]}],
 "links": [
   {"from": "tapi", "to": "chat", "label": "compose"},
   {"from": "svc", "to": "db", "label": "read / write", "both": true},
   {"from": "chat", "to": "llm", "label": "LLM", "style": "dashed"}],
 "steps": [{"n": 1, "text": "The app calls tenant-api."}, {"n": 2, "text": "The chat is stored."}]}
```

- **Groups are where things run**, left to right: a machine, a cloud, a tenant, the outside world. **Tiers**
  are the dashed boxes inside (clients, services, stores, workers); a group with one tier may list `parts`
  directly (one column, or the group's `cols`). `cols` sets a tier's columns (default: one row, up to 4).
- `role` picks the icon: `client`, `service`, `db`, `files`, `worker`, `external`. Draw the real system's
  parts with their real names — no vendor logos; the stack goes in `sublabel` (`Node · Cloud Run`).
- **Links** join parts, tiers or groups — link two tiers ("read / write") instead of every part pair, so the
  picture stays readable. `style: "dashed"` for async / optional, `both: true` for two-way.
- **Steps:** a part's `step: N` puts a numbered badge on it; `steps` lists every number with one sentence.
  Clicking a badge opens the list. Number one request end to end, not everything.
- A part with more inside gets `ref: "<that chart>"` (**Open ↗**) and its `flow dep add` link (`SKILL.md` §3).
- At most ~30 parts — past that, zoom with `ref`.
- Check before you finish:
  ```bash
  python3 -I <this skill>/templates/architecture/check_architecture.py "$D"
  DM check --<ns>--.chartit.architecture "$(cat "$D/architecture.json")"
  ```
