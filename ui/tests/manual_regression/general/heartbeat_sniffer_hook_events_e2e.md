test 1: sniffer activation writes hooks to settings.json
- start backend: `python minihub/run.py` (port 9007)
- start frontend: `cd minihub/ui && npm run dev` (port 4097)
- open browser to `http://localhost:4097`
- validate homepage loads without errors
- activate sniffer via API: `curl -s -X POST http://localhost:9007/api/v1/graph/hooks-sniffer`
- validate response: `{"status":"SUCCESS","data":{"enabled":true,"hook_id":"...","hook_scope":"user"}}`
- check `~/.claude/settings.json` has hooks entries for all events (PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop)
- each hook entry should have `flow_metadata.name` = `"flowpad_sniffer"` and a command containing `flow hooks report`
- the command URL should point to `http://localhost:9007/api/v1/webhook/listen`

test 2: sniffer deactivation removes hooks from settings.json
- with sniffer active from test 1
- deactivate sniffer via API: `curl -s -X DELETE http://localhost:9007/api/v1/graph/hooks-sniffer`
- validate response: `{"status":"SUCCESS","data":{"enabled":false}}`
- check `~/.claude/settings.json` — all `flowpad_sniffer` hook entries should be removed
- non-flow hooks (if any) should remain untouched

test 3: webhook listen endpoint receives events
- activate sniffer: `curl -s -X POST http://localhost:9007/api/v1/graph/hooks-sniffer`
- copy `hook_id` from the activation response (used as `agent_hook_id`)
- send a test event directly via curl:
  ```
  curl -s -X POST http://localhost:9007/api/v1/webhook/listen \
    -H "Content-Type: application/json" \
    -d '{"webhook_type":"agent_hook","webhook_payload":{"agent_hook_id":"<hook_id>","hook_entry_id":"<hook_id>","hook_data":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"},"session_id":"test-123","raw_hook_data":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"},"session_id":"test-123"}}}}'
  ```
- validate response is `200 OK` and returns immediately (no hanging)
- validate server logs show the event was processed

test 4: real Claude CLI hook events appear on heartbeat bar
- ensure sniffer is active (test 1)
- open browser to `http://localhost:4097`
- validate homepage loads, heartbeat bar visible at bottom (green dot, DEBUG button, time spans)
- in a separate terminal, run: `claude -p "say hello"`
- wait for Claude CLI to complete
- switch back to browser
- validate heartbeat bar shows event count (number next to DEBUG increases)
- validate heartbeat timeline shows new event icons

test 5: heartbeat event list and detail view
- with events from test 4 visible on heartbeat bar
- click the DEBUG button or the event count area on the heartbeat bar
- validate events list panel opens
- validate list shows hook events (PreToolUse, PostToolUse, UserPromptSubmit, Stop, etc.)
- each event should show: event type, timestamp, tool name (for tool events)
- click on an individual event in the list
- validate detail view opens showing full event payload (JSON data)
- close the detail view
- validate return to events list

test 6: listen endpoint does not hang (regression)
- send a large payload to the listen endpoint:
  ```
  curl -s -X POST http://localhost:9007/api/v1/webhook/listen \
    -H "Content-Type: application/json" \
    -d '{"webhook_type":"agent_hook","webhook_payload":{"agent_hook_id":"<hook_id>","hook_entry_id":"<hook_id>","hook_data":{"hook_event_name":"PostToolUse","tool_name":"Bash","output":"very long output...","session_id":"test-456","raw_hook_data":{"hook_event_name":"PostToolUse","tool_name":"Bash","output":"very long output...","session_id":"test-456"}}}}' \
    --max-time 5
  ```
- validate response returns within 5 seconds (must not hang)
- this is a regression test for the ASGI body-read bug where the graph route consumed the request body before the handler could read it
