---
id: 6f9a1c2e-8d4b-4a91-bc23-1e5f7a9c0d12
---

# Sniffer is OPT-IN, default OFF (InstanceSettings.sniffer_enabled, default False).
# bootstrap returns sniffer_hook=null unless the instance gate is enabled; there is
# no HTTP endpoint to flip the instance gate (the localStorage pref is per-user, not
# per-instance). These tests assert the shipped default-off contract.

test 1: Bootstrap reflects the default-off sniffer contract
- [bash] run "curl -sS {API_URL}/api/v1/graph/bootstrap"
- validate the JSON response has a "data" object
- validate data has a "sniffer_hook" key
- validate data.sniffer_hook is null (sniffer is opt-in; the instance gate is off by default, so no hook is auto-installed)

test 2: Bootstrap is stable across calls (no auto-install side effect)
- [bash] run "curl -sS {API_URL}/api/v1/graph/bootstrap"
- validate data.sniffer_hook is still null on a second call (reading bootstrap never silently enables the sniffer)
