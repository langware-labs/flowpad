---
id: 01ae5dcc-8394-516e-a6b9-1a9a8184d8f6
---

precondition: opt the sniffer in (default is OFF since v0.2.21)
- in a fresh tab, before navigation, run:
  `localStorage.setItem('flowpad.snifferEnabled', 'true')`
- # Sniffer is opt-in via InstanceSettings.sniffer_enabled + the user's
- #   localStorage preference. Priming reflects an already-opted-in user
- #   and is the realistic state for these scenarios.

test 1: sniffer captures events via webhook listen endpoint
- start backend and frontend; open browser to `http://localhost:4097` (with the localStorage flag primed above)
- wait for window.appReady === true
- verify sniffer is enabled (green dot in EventSnifferChip)
- get the sniffer hook ID from console: `window.context.snifferHook.entity.id`
- send a synthetic hook event directly:
  ```
  curl -s -X POST http://localhost:9007/api/v1/webhook/listen \
    -H "Content-Type: application/json" \
    -d '{"webhook_type":"agent_hook","webhook_payload":{"agent_hook_id":"<hook_id>","hook_entry_id":"<hook_id>","hook_data":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo test"},"session_id":"test-session-001","raw_hook_data":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo test"},"session_id":"test-session-001","cwd":"/tmp"}}}}'
  ```
- verify response returns quickly (< 2s) with 200 OK
- in browser console: `window.sniffer?.flowDataStream?._ownItems?.length` — verify count > 0
- verify EventSnifferChip shows an event icon in the heartbeat chart (within the 1M timespan)

test 2: event appears in EventListPanel popover
- with at least one event captured (test 1)
- click the expand icon (Maximize2) on the EventSnifferChip
- verify EventListPanel opens showing "1 Events captured" (or more)
- verify event row shows: event type "PreToolUse", tool name "Bash"
- close the popover

test 3: event count increments in real-time
- note current event count shown in chip (e.g., "(3)")
- send another synthetic event via curl (test 1 payload)
- verify chip count increments within ~2 seconds (no page reload needed)
- verify new event icon appears in heartbeat chart

test 4: clearing events resets count
- with events visible in chip
- click the expand icon to open EventListPanel
- click the "Clear" button
- verify "0 Events captured" shown in popover
- verify heartbeat chart is empty
- verify chip shows no event count
- in browser console: `window.sniffer?.flowDataStream?._ownItems?.length` — verify returns 0

test 5: pausing freezes displayed events
- with sniffer enabled and at least 1 event in chip
- click the expand icon, then click the "Pause" button (if visible in popover or chip)
- send another synthetic event via curl
- verify the displayed event count does NOT increase while paused
- click "Resume"
- verify count updates to include the event sent while paused
