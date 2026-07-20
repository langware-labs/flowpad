"""Group-task member status reaches the owner through the hub (live, 3 instances).

Scenario (the exact ask): an OWNER creates a task, turns it into a GROUP task
assigned to TWO members, each member independently changes the status of their
own member task, and when the owner checks he sees BOTH members' up-to-date
status. This is the real-transport counterpart of the faked-hub unit coverage in
``tests/api/test_group_task_action.py::test_sync_group_merges_member_owned_fields``
(which stubs a single member's hub row); here nothing is faked.

Mechanism under test (see ``flow_sdk/app/actions/group_task_action.py``):
  - ``create-group-task`` fans the task out to one ``is_child`` member task per
    member on the hub (title-only clone, ``assignee`` = member) and sends each a
    membership invitation (``editor`` on their child + ``guest`` on the parent).
  - A member owns only ``status`` / ``completed_at`` (their deliverable rides a
    ``Comment`` on the member task, not a field). When a member edits status
    locally with ``Hub-Reflect: true``, the remote member task mirrors the
    change to its hub row (there is NO hub→local push for plain tasks —
    freshness is pull-based by design).
  - The owner pulls freshness with the ``sync-group`` action, which LWW-merges
    ``_MEMBER_OWNED_FIELDS = ("status",)`` from each child's hub row onto the
    owner's local child mirror, and pulls each child's comments (the member's
    submission note) via ``_sync_remote_children``.

Topology: three real backends (instance_ctl ``dev-1`` = owner, ``dev-2`` = m1,
``dev-3`` = m2) + the local hub. Each backend owns its own hub connection — the
faithful way to exercise reflect + ``sync-group``. Assertions read the owner's
REST after a ``sync-group`` catch-up. Driven SYNCHRONOUSLY (httpx.Client): the
flow is sequential and a sync client avoids the pytest-asyncio per-await cost.

Caps (CLAUDE.md, non-negotiable — never raise): pytest.ini ``--timeout=30``.
Normal convergence is sub-second; ``CONVERGE`` is a 10s safety deadline (well
above normal — NOT a slow-path mask). Requires the three instances up +
cloud-logged-in and a local hub; skips cleanly otherwise.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
OWNER_INSTANCE = os.environ.get("OWNER_INSTANCE", "dev-1")
M1_INSTANCE = os.environ.get("M1_INSTANCE", "dev-2")
M2_INSTANCE = os.environ.get("M2_INSTANCE", "dev-3")
# Per-assertion convergence deadline. Normal is sub-second; a safety cap, NOT a
# slow-path mask — do not raise (CLAUDE.md). The 30s pytest cap bounds the run.
CONVERGE = 10.0


def _instance_backend(name: str) -> str | None:
    """Backend base URL for an instance_ctl instance, from ``.env.<name>.local``."""
    env = REPO_ROOT / f".env.{name}.local"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        line = line.strip()
        if line.startswith("LOCAL_SERVER_PORT="):
            port = line.split("=", 1)[1].strip().strip('"').strip("'")
            return f"http://localhost:{port}"
    return None


def _reachable_logged_in(base: str) -> bool:
    try:
        if httpx.get(f"{base}/api/v1/health/status", timeout=2.0).status_code // 100 != 2:
            return False
        data = (httpx.get(f"{base}/api/v1/cloud/status", timeout=3.0).json() or {}).get("data") or {}
        return (data.get("login") or {}).get("status") == "logged_in"
    except Exception:
        return False


@pytest.fixture(scope="module")
def three_backends(hub_base_url) -> dict:
    owner = _instance_backend(OWNER_INSTANCE)
    m1 = _instance_backend(M1_INSTANCE)
    m2 = _instance_backend(M2_INSTANCE)
    if not owner or not m1 or not m2:
        pytest.skip(
            "three instances required: "
            f"`scripts/instance_ctl.sh launch {OWNER_INSTANCE}` (owner), "
            f"`{M1_INSTANCE}` and `{M2_INSTANCE}` (members)"
        )
    if not (_reachable_logged_in(owner) and _reachable_logged_in(m1) and _reachable_logged_in(m2)):
        pytest.skip("all three backends must be up and cloud-logged-in")
    return {
        "owner": owner,
        "m1": m1,
        "m2": m2,
        "hub": hub_base_url,
        # instance_ctl convention: hub user `<name>@local.test`, password `<name>-pw-1234`.
        "m1_pw": os.environ.get("M1_PW", f"{M1_INSTANCE}-pw-1234"),
        "m2_pw": os.environ.get("M2_PW", f"{M2_INSTANCE}-pw-1234"),
    }


def _u(r: httpx.Response):
    r.raise_for_status()
    j = r.json()
    if isinstance(j, dict) and j.get("status") not in (None, "SUCCESS", "success"):
        raise RuntimeError(f"{r.request.method} {r.request.url} -> {str(j)[:200]}")
    return j.get("data") if isinstance(j, dict) else j


def _email(c: httpx.Client, be: str) -> str:
    return (_u(c.get(f"{be}/api/v1/cloud/status"))["login"]["user"]["email"]).strip().lower()


def _hub_hdr(c: httpx.Client, hub: str, email: str, pw: str) -> dict:
    d = c.post(f"{hub}/api/v1/login", json={"email": email, "password": pw}).json()["data"]
    return {"Authorization": f"Bearer {d.get('api_key') or d['token']}"}


def _task(c: httpx.Client, be: str, cid: str) -> dict | None:
    r = c.get(f"{be}/api/v1/graph/task/{cid}")
    if r.status_code != 200:
        return None
    d = r.json().get("data")
    return d if isinstance(d, dict) and d.get("id") == cid else None


def _wait_task(c: httpx.Client, be: str, cid: str) -> dict | None:
    """Poll until the member has locally materialized their member task."""
    end = time.monotonic() + CONVERGE
    while time.monotonic() < end:
        d = _task(c, be, cid)
        if d is not None:
            return d
        time.sleep(0.3)
    return None


def _accept(c: httpx.Client, hub: str, member_be: str, hub_hdr: dict, child_id: str) -> bool:
    """Member discovers their invitation on the hub (its targets carry their own
    member-task id) and accepts through their OWN backend, materializing the
    ``remote=True`` member task locally."""
    end = time.monotonic() + CONVERGE
    while time.monotonic() < end:
        pending = (c.get(f"{hub}/api/v1/graph/invitation/pending", headers=hub_hdr).json().get("data")) or []
        inv = [i for i in pending if child_id in str(i) and not i.get("accepted")]
        if inv:
            c.post(f"{member_be}/api/v1/graph/invitation-accept", json={"invitation_id": inv[0]["id"]})
            return True
        time.sleep(0.3)
    return False


def _set_status(c: httpx.Client, be: str, cid: str, status: str) -> None:
    """Member edits their member-task status; ``Hub-Reflect`` mirrors it to the
    hub row (the member task is ``remote=True`` after accept)."""
    _u(c.put(f"{be}/api/v1/graph/task/{cid}", json={"status": status}, headers={"Hub-Reflect": "true"}))


def _owner_statuses(c: httpx.Client, owner: str, parent_id: str, child_ids: list[str]) -> dict:
    """Fire the owner's ``sync-group`` catch-up, then read each child's status
    from the owner's local mirror."""
    try:
        c.post(f"{owner}/api/v1/graph/task/{parent_id}/sync-group", json={})
    except Exception:
        pass
    out = {}
    for cid in child_ids:
        d = _task(c, owner, cid)
        out[cid] = d.get("status") if d else None
    return out


def _wait_owner_sees(c, owner, parent_id, expected: dict) -> dict:
    """Poll ``sync-group`` until the owner's local children match every expected
    (child_id -> status). Returns the last-observed status map."""
    child_ids = list(expected)
    end = time.monotonic() + CONVERGE
    last: dict = {}
    while time.monotonic() < end:
        last = _owner_statuses(c, owner, parent_id, child_ids)
        if all(last.get(cid) == want for cid, want in expected.items()):
            return last
        time.sleep(0.3)
    return last


def test_group_task_member_status_reaches_owner(three_backends):
    """Owner assigns a group task to two members; both change status; the owner's
    ``sync-group`` catch-up surfaces BOTH members' up-to-date status."""
    env = three_backends
    owner, m1, m2, hub = env["owner"], env["m1"], env["m2"], env["hub"]
    c = httpx.Client(timeout=15.0)
    try:
        m1_email = _email(c, m1)
        m2_email = _email(c, m2)
        m1_hdr = _hub_hdr(c, hub, m1_email, env["m1_pw"])
        m2_hdr = _hub_hdr(c, hub, m2_email, env["m2_pw"])

        # 1) Owner creates a task and fans it out to the two members as a group task.
        parent_id = _u(c.post(f"{owner}/api/v1/graph/task", json={"type": "task", "title": "Quarterly audit"}))["id"]
        res = _u(
            c.post(
                f"{owner}/api/v1/graph/task/{parent_id}/create-group-task",
                json={"members": [{"email": m1_email}, {"email": m2_email}]},
            )
        )
        assert sorted(res["created"]) == sorted([m1_email, m2_email]), f"fan-out did not create both members: {res}"

        # Map member email -> their member-task id via the owner's local children
        # (the response omits emails by design; the ``assignee`` field is the join).
        child_ids = [tid.split("task-", 1)[1] for tid in res["children"]]
        by_email = {}
        for cid in child_ids:
            row = _wait_task(c, owner, cid)
            assert row is not None, f"owner never materialized member task {cid}"
            assert row["status"] == "to_do", "a fresh member task must start at to_do"
            by_email[(row.get("assignee") or "").strip().lower()] = cid
        m1_child = by_email[m1_email]
        m2_child = by_email[m2_email]

        # 2) Each member accepts their invitation, then changes their own status.
        assert _accept(c, hub, m1, m1_hdr, m1_child), "member 1 never received/accepted their invitation"
        assert _accept(c, hub, m2, m2_hdr, m2_child), "member 2 never received/accepted their invitation"
        assert _wait_task(c, m1, m1_child), "member 1 never materialized their member task locally"
        assert _wait_task(c, m2, m2_child), "member 2 never materialized their member task locally"

        _set_status(c, m1, m1_child, "in_progress")  # member 1 → In Progress
        _set_status(c, m2, m2_child, "done")  # member 2 → Done

        # 3) Owner checks: sync-group must surface BOTH members' up-to-date status.
        seen = _wait_owner_sees(c, owner, parent_id, {m1_child: "in_progress", m2_child: "done"})
        assert seen.get(m1_child) == "in_progress", f"owner did not see member 1's In Progress: {seen}"
        assert seen.get(m2_child) == "done", f"owner did not see member 2's Done: {seen}"

        # 4) And a later change propagates too (freshness, not a one-shot copy):
        #    member 1 finishes; the owner's next catch-up reflects it.
        _set_status(c, m1, m1_child, "done")
        seen = _wait_owner_sees(c, owner, parent_id, {m1_child: "done", m2_child: "done"})
        assert seen.get(m1_child) == "done", f"owner did not see member 1's later Done: {seen}"
    finally:
        c.close()
