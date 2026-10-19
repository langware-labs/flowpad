---
id: 247edca2-2207-589f-9cd9-18f52608a1ab
---

# The sniffer state (sniffer_hook / sniffer_installed) is served by the deferred
# /api/v1/graph/info route, not /graph/bootstrap (split out of bootstrap so boot
# does not wait on it; see docs/boot.md).
# Sniffer is OPT-IN, default OFF. This test asserts the default-off bootstrap
# contract is consistent and idempotent across repeated calls (no per-call
# auto-install, no drift). Uses {API_URL} from .env (port 9008 in this env).

test 1: Bootstrap sniffer state is consistent across two calls
- [bash] run "curl -sS {API_URL}/api/v1/graph/info"
- validate data.sniffer_hook is null
- [bash] run "curl -sS {API_URL}/api/v1/graph/info"
- validate data.sniffer_hook is still null (idempotent default-off; no per-call side effect)
