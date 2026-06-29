---
id: d1a6b81f-f10d-55f1-b865-dfebacb2bbd9
---

test 1: Search API handles limit=0 and limit=-1 without 500 error

REGRESSION: Fixed 2026-03-07 — limit=0 passed to LanceDB caused ValueError → HTTP 500.
Fix: ge=1 constraint in server/routes/search.py Query param;
     max(1, limit) clamp in compute_node._handle_fs_records_search().

- [bash] verify limit=1 constrains results: GET {API_URL}/api/v1/search?q=test&limit=1 returns 200 with results.length <= 1
- [bash] verify limit=0 does not return 500: GET {API_URL}/api/v1/search?q=test&limit=0 returns status != 500
- [bash] verify limit=-1 does not return 500: GET {API_URL}/api/v1/search?q=test&limit=-1 returns status != 500
