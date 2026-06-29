---
id: 7a0b2d3f-1c5e-4b82-9d04-3f6a8b1e2c70
---

# Sniffer is OPT-IN, default OFF. With the instance gate off there is no
# sniffer_hook and therefore no event-capture surface. This test asserts the
# shipped default-off contract (no hook -> nothing to capture), which is correct
# app behavior, not a failure.

test 1: No sniffer hook means no capture surface
- [bash] run "curl -sS {API_URL}/api/v1/graph/bootstrap"
- validate data.sniffer_hook is null (default-off: the capture hook is not installed)

test 2: No sniffer agent_hook entity is present by default
# The sniffer hook is an `agent_hook` entity named "Hooks Sniffer" (uname "sniffer"),
# NOT a `claude_hook` (that type endpoint 422s). The canonical gate-state check is
# the hooks-sniffer status action.
- [bash] run "curl -sS {API_URL}/api/v1/graph/hooks-sniffer"
- validate the response is 200 with data.enabled == false and data.hook_id == null (default-off: no sniffer hook installed)
- [bash] run "curl -sS {API_URL}/api/v1/graph/agent_hook"
- validate the response is 200 with a "data" array
- validate no entry in data has name "Hooks Sniffer" (default-off: the sniffer hook is not auto-created)
