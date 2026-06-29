---
id: d5b076f3-d845-5740-8810-5b9a3203f042
---

# Sniffer is OPT-IN, default OFF. This test asserts the default-off state holds
# across SPA navigation (the per-instance gate does not get flipped by client-side
# routing or the per-user localStorage pref). Uses {APP_URL}=4098 / {API_URL}=9008.

test 1: Default-off sniffer state is unchanged after SPA navigation
- navigate to {APP_URL}/dock/home
- wait for the home page to render
- navigate to {APP_URL}/dock/shell
- wait for the shell view to render
- navigate to {APP_URL}/dock/home
- [bash] run "curl -sS {API_URL}/api/v1/graph/bootstrap"
- validate data.sniffer_hook is null (SPA navigation never enables the per-instance sniffer gate)
- check console for SNIFFER-RELATED errors only
- validate no sniffer-related console errors appeared. NOTE: ignore ambient navigation noise unrelated to the sniffer — `Failed to load resource` and `Failed to list Claude projects: TypeError: Failed to fetch` (an in-flight use-claude-projects fetch aborted by the route transition). Those are not sniffer regressions.
