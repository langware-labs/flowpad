---
id: 421b3fc5-7027-5c93-b276-c2b807276678
---

# Sniffer is OPT-IN, default OFF. With the instance gate off there is no
# sniffer_hook, so no hook/heartbeat sniffer events flow. This test asserts the
# shipped default-off contract (bootstrap reachable + no sniffer hook installed),
# which is correct app behavior. Uses {API_URL}=9008.

test 1: Backend is reachable (bootstrap heartbeat)
- [bash] run "curl -sS -o /dev/null -w '%{http_code}' {API_URL}/api/v1/graph/bootstrap"
- validate the HTTP status is 200

test 2: No sniffer hook events by default (default-off)
- [bash] run "curl -sS {API_URL}/api/v1/graph/bootstrap"
- validate data.sniffer_hook is null (the per-instance sniffer gate is off; no hook is installed, so no sniffer/heartbeat hook events are captured)
