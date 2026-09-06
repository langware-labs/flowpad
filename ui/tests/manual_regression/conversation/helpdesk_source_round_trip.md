---
id: fed3f986-aad5-4865-bc55-013800129277
---

# Help desk as a message source — guest ticket round trip

Two instances against the local hub: `{APP_URL_1}` is the GUEST (dev-1),
`{APP_URL_2}` is STAFF (dev-2). Launch them sequentially:
`scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2`.
The desk is a project STAFF creates for the run (`enable_helpdesk`), so nothing
here needs `HELPDESK_STAFF_EMAILS`; `{HUB}` is `http://localhost:8093`.

What is being proved: a hub help desk is an ordinary MessageSource. Staff attach
it from the inbox line, a guest ticket lands as an inbox conversation wearing
the Help desk chip, the reply goes from the composer through the source (pickup
happens on the way), the hub masks it to the desk brand, and the sent copy
converges on one row.

## Setup
- [api] as STAFF: `POST {HUB}/api/v1/graph/project {"name":"desk-manual"}` → `DESK`; then
  `POST {HUB}/api/v1/graph/project/$DESK/enable_helpdesk {"enabled":true,"display_name":"Manual Support","mode":"human"}`

## Steps

### 1. Staff attach the desk from the inbox line
- [browser:staff] navigate to `{APP_URL_2}/dock/inbox`
- [browser:staff] click data-testid="attached-channels-add"; pick the **Help desk** tile; the Desk field offers the desks this login belongs to — pick `desk-manual` (or paste `$DESK`); Add source
- PASS when: a LifeBuoy mark (data-testid="attached-channel", data-provider="helpdesk") appears on the line with a green dot; hovering it reads "Help desk · listening"

### 2. A guest opens a ticket
- [browser:guest] on `{APP_URL_1}` open the help-desk ask surface for `$DESK` (or [api] as GUEST: `POST {HUB}/api/v1/graph/project/$DESK/start_guest_conversation {"text":"my printer is broken <ts>"}`) → `TICKET`
- PASS when: the hub returns the conversation id

### 3. The ticket is an inbox row on the staff side
- [browser:staff] on `{APP_URL_2}/dock/inbox` wait for the next poll (≤60s, or press the mark's details → the source's Pull)
- PASS when: a row appears with the guest's name, the **Help desk** chip (data-chip-type="source") and the ticket text; clicking the LifeBuoy mark filters the list to it; [api] `GET {API_URL_2}/api/v1/graph/conversation/$TICKET` exists locally with that id

### 4. Reply from the composer
- [browser:staff] open the row; the composer reads "Reply in Help desk"; send `try restarting it <ts>`
- PASS when: [api] `GET {HUB}/api/v1/graph/conversation/$TICKET/flow_message` (as STAFF) carries the reply with `sender_name == "Manual Support"` and `sender_id` = staff's hub id; `GET .../project/$DESK/helpdesk_conversations` shows `picked_up: true`

### 5. The sent copy converges
- [browser:staff] after the next poll the reply shows under the row as "Manual Support"
- PASS when: [api] the local conversation's messages are exactly the two hub message ids — no twin

### 6. The guest sees the brand
- [browser:guest] open the ticket conversation on `{APP_URL_1}`
- PASS when: the reply renders as **Manual Support**, not the staffer's name

### 7. Off is off
- [browser:staff] details (data-testid="attached-channels-details") → flip the desk's switch off; guest opens a second ticket
- PASS when: no new row appears until the switch is flipped back on and a poll runs

## Cleanup
- [api] as STAFF: `DELETE {HUB}/api/v1/graph/project/$DESK`
