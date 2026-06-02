---
id: 77455683-6cdc-5884-aef3-8e9cd9e966b5
---

# Conversation title rename-on-click + live cross-client update

Verifies that the conversation header title is **rename-on-click**, and that a
rename in one client updates **every other client viewing the same conversation**
in near real time. The rename itself is deliberately just
`conversation.title = <new>; conversation.save()` — the test is "big" only in that
a green run exercises the whole stack end to end:

```
click title → inline input → Enter
  → APIEntity.save() → PUT /api/v1/graph/conversation/<id>
  → handle_update_by_id → update_by_id → save(notify=True)
  → DataOpMessage(op=UPDATE) broadcast over the local WS
  → other client's ConnectionManager → useEntity subscriber → header re-renders
```

Reflection note: `save()` does **not** opt into hub reflection (no `Hub-Reflect`
header), so it updates the local row + broadcasts to all clients on **that
backend**. Cross-*user* propagation (alice's backend → bob's backend) additionally
requires the hub to fan conversation field updates to participants — which the
current local hub does not do — so this scenario validates the cross-client path
on a single backend (two tabs / two windows). See
[`two_instance_hub_conversation.md`](./two_instance_hub_conversation.md) for the
cross-user hub path.

## Prereqs

- One running flow-cli instance from this checkout. Easiest via the launcher:
  ```bash
  scripts/instance_ctl.sh launch ra1     # → frontend :5007, backend :6003 (ports scan upward if busy)
  ```
  (Any cloud-logged-in-or-not backend works; cloud login is not required — the
  rename is a local save.)
- At least one conversation on that backend. List them:
  ```bash
  curl -s "http://localhost:<BE>/api/v1/graph/conversation" \
    | python3 -c "import sys,json;[print(c['id'],'->',repr(c.get('title'))) for c in json.load(sys.stdin)['data'][:8]]"
  ```
  Record one `<CONV>`.

## Steps

### 1. Open the conversation in two tabs

Navigate two browser tabs to the SAME conversation on the instance frontend:

```
http://localhost:<FE>/dock/conversation/<CONV>
```

PASS when both tabs show the conversation header with the title rendered as a
`[data-testid="conversation-title"]` span carrying a `title="Click to rename"`
tooltip and the conversation's current title text (not the static `Conversation`
fallback). Source: `ui/src/components/conversation/ConversationPanel.tsx`
(`EditableConversationTitle`).

### 2. Rename in tab 1

In tab 1, click the title span — it becomes a
`[data-testid="conversation-title-input"]`. Type a new unique title (e.g.
`renamed-via-ui-2tabs`) and press **Enter** (blur also commits; **Escape**
cancels).

PASS when tab 1's input reverts to the span and shows the new title.

Driving via Playwright/debugMCP — the title click needs the React onClick (the
element may fail the visible/stable gate), so trigger it directly:

```js
document.querySelector('[data-testid="conversation-title"]').click();         // → input appears
// fill [data-testid="conversation-title-input"] with the new title, press Enter
```

### 3. Verify the other tab updated — the binding assertion

Switch to tab 2 (which was never touched) and read the title.

PASS when tab 2's `[data-testid="conversation-title"]` shows the **new title**
within ~1s — updated purely by the `save()` → `data_op` broadcast → `useEntity`
re-render, with no interaction in tab 2. This is the end-to-end proof.

Also confirm persistence: `GET /conversation/<CONV>` on the backend returns the
new `title`.

## Failure modes & first-pass debugging

| Symptom | Likely cause | First check |
|---|---|---|
| Title shows static `Conversation`, not the conv title | header still renders `headerLabel`, not `convEntity.title` | confirm `EditableConversationTitle` is wired in `ConversationPanel.tsx` and `useEntity` returns the conv |
| Click does nothing | clicked before HMR / wrong testid | snapshot for `[data-testid="conversation-title"]`; trigger `el.click()` directly |
| Tab 1 renames but **tab 2 does not update** | local WS broadcast not reaching tab 2 | check the backend emitted a `data_op` UPDATE (backend log); confirm tab 2's WS is connected (`/api/v1/connect/ws`); confirm `useEntity` subscribed for `conversation-<id>` |
| New title reverts after a few seconds | a hub sync (`fetchConversations`) overwrote the local-only title | expected for a shared conv when the rename was not reflected to the hub — use `conversation.rename()` (hub_reflect) if hub persistence is required |

## Teardown

Scratch data — leave the renamed conversation in place. Stop the instance with
`scripts/instance_ctl.sh kill ra1`.
