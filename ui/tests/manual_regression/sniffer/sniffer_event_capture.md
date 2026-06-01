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

test 2: No claude_hook sniffer entity is present by default
- [bash] run "curl -sS {API_URL}/api/v1/graph/claude_hook"
- validate the response is 200 with a "data" array
- validate no entry in data is the flowpad sniffer hook (default-off: the sniffer hook is not auto-created)
