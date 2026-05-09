# CollaborationRoom: add_process flow

Verifies the end-to-end HTTP contract for creating a collaboration code on a
Project, joining it, spawning an AgenticProcess on a ComputeNode, and linking
that process to a CollaborationRoom via `add_process`. Also exercises a
negative (missing/bogus) `agentic_process_id` payload.

## Prereqs

- Backend running at `http://localhost:$LOCAL_SERVER_PORT` (default 9008).
- At least one `project` entity and one `compute_node` entity exist.
- `GET /api/v1/graph/project` returns a non-empty list — pick the first entry
  and record both `uname` and `id`.
- `GET /api/v1/graph/compute_node` returns a non-empty list — pick the `local`
  node (or the first entry) and record its `id`.

> Note: the generic graph router for instance actions currently resolves by
> entity `id`, not by `uname`. Use the `id` in URLs below. A `uname` in the URL
> returns HTTP 422 `"Unknown resource type or action"`.

## Steps (curl)

All examples assume:

```bash
HUB=http://localhost:9008
PROJ_ID=<project id from GET /api/v1/graph/project>
NODE_ID=<compute_node id, e.g. local>
```

### 1. Ensure collaboration code on the project (idempotent)

```bash
curl -sS -X POST "$HUB/api/v1/graph/project/$PROJ_ID/ensure-collaboration-code" \
  -H 'Content-Type: application/json' \
  -d '{"host_name":"QA Tester","host_member_id":"qa-member-001"}'
```

PASS when:
- HTTP 200, `status=SUCCESS`.
- `data.session_code` is a non-empty string (format like `XXXX-XXXX`).
- `data.host_member_id == "qa-member-001"`.
- `data.members` contains an entry with `member_id=qa-member-001`.
- Re-running the same call does not rotate `session_code` (idempotent).

### 2. Join the project's collaboration

```bash
curl -sS -X POST "$HUB/api/v1/graph/project/$PROJ_ID/join-collaboration" \
  -H 'Content-Type: application/json' \
  -d '{"member_id":"qa-member-002","name":"QA Joiner"}'
```

PASS when:
- HTTP 200, `status=SUCCESS`.
- `data.members` now contains both `qa-member-001` and `qa-member-002`.
- Missing `member_id` or `name` → `status=FAIL` with message
  `"member_id and name are required"`.

### 3. Create a CollaborationRoom entity

There is no higher-level endpoint that creates a CollaborationRoom from the
project code — create the entity via the generic graph create route:

```bash
curl -sS -X POST "$HUB/api/v1/graph/collaboration_room" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PROJ_ID\",\"host_name\":\"QA Tester\",\"host_member_id\":\"qa-member-001\",\"name\":\"QA Regression Room\"}"
```

PASS when:
- HTTP 200, `status=SUCCESS`.
- `data.id` is a UUID — record as `RID`.
- `data.status == "active"`, `members == []`, `agentic_process_ids == []`,
  `started_at` and `updated_at` populated.

### 4. Join the CollaborationRoom entity itself (action `join`)

```bash
curl -sS -X POST "$HUB/api/v1/graph/collaboration_room/$RID/join" \
  -H 'Content-Type: application/json' \
  -d '{"member_id":"qa-member-002","name":"QA Joiner"}'
```

PASS when:
- HTTP 200, `status=SUCCESS`.
- `data.members` contains `{member_id: qa-member-002, name: "QA Joiner", ...}`.
- Missing `member_id`/`name` → `status=FAIL` with
  `"member_id and name are required"`.

### 5. Create a minimal AgenticProcess on a ComputeNode

```bash
curl -sS -X POST "$HUB/api/v1/graph/compute_node/$NODE_ID/createProcess" \
  -H 'Content-Type: application/json' \
  -d "{\"context\":{\"project_id\":\"$PROJ_ID\"},\"visible\":true}"
```

PASS when:
- HTTP 200, `status=SUCCESS`.
- `data.type == "agentic_process"` and `data.id` is a UUID — record as `PID`.

### 6. Link the process to the room (action `add_process`)

```bash
curl -sS -X POST "$HUB/api/v1/graph/collaboration_room/$RID/add_process" \
  -H 'Content-Type: application/json' \
  -d "{\"agentic_process_id\":\"$PID\"}"
```

PASS when:
- HTTP 200, `status=SUCCESS`.
- `data.ok == true` on first add, `false` on a repeated call with the same PID.
- `data.agentic_process_ids` includes `PID`.

### 7. GET the room and verify the process list is populated

```bash
curl -sS "$HUB/api/v1/graph/collaboration_room/$RID"
```

PASS when:
- HTTP 200, `status=SUCCESS`.
- `data.agentic_process_ids` contains `PID`.
- `data.members` contains `qa-member-002`.
- `data.updated_at` > `data.started_at`.

### 8. Negative: missing agentic_process_id

```bash
curl -sS -X POST "$HUB/api/v1/graph/collaboration_room/$RID/add_process" \
  -H 'Content-Type: application/json' -d '{}'
```

PASS when the server rejects with a 4xx-style failure body
(`status=FAIL`, message mentioning `agentic_process_id`). Ideally HTTP 400
rather than 500.

### 9. Negative: bogus agentic_process_id

```bash
curl -sS -X POST "$HUB/api/v1/graph/collaboration_room/$RID/add_process" \
  -H 'Content-Type: application/json' \
  -d '{"agentic_process_id":"00000000-dead-beef-0000-000000000000"}'
```

Expected (ideal) behavior: HTTP 4xx, `status=FAIL`, message indicating the
process does not exist. If the server happily appends the unknown id with
`status=SUCCESS`, record as a FAIL — `add_process` must validate existence.

## Teardown

Leave created entities in place (regression scratch data). If a cleanup pass is
needed, `DELETE /api/v1/graph/collaboration_room/$RID` and
`DELETE /api/v1/graph/agentic_process/$PID`.
