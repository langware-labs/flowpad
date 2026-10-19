"""The Tasks channel between two people (live: two backends + the local hub, nothing faked).

Each person's backend has its own Tasks channel (``task_manager``, principal ``user:local``, created
at startup): their tasks as threads in their stream inbox, pulled like any channel and nudged by the
bus. A task shared through the hub is one thread on each side, and what either person does reaches
the other through the hub's ordinary task/comment sync — the channel only reads it.

S1 Task it → the owner's thread opens.  S2 the owner assigns it → both have the thread.  S3 the
assignee moves it → the owner reads it in the thread.  S4 the owner replies in the thread → the
assignee reads it in the thread AND on the task (its comments).

The in-process counterpart (owner side, hub faked) is ``tests/api/test_tasks_channel.py``.

Topology: ``scripts/instance_ctl.sh launch <owner>`` and ``<assignee>`` (defaults ``dev-1`` /
``dev-2``; override with OWNER_INSTANCE / ASSIGNEE_INSTANCE), each cloud-logged-in, + a local hub.
Skips cleanly otherwise. Caps (CLAUDE.md, never raise): pytest.ini ``--timeout=30``; ``CONVERGE`` is a
safety deadline well above normal sub-second convergence, NOT a slow-path mask.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
OWNER_INSTANCE = os.environ.get("OWNER_INSTANCE", "dev-1")
ASSIGNEE_INSTANCE = os.environ.get("ASSIGNEE_INSTANCE", "dev-2")
CONVERGE = 10.0
GRAPH = "/api/v1/graph"


def _instance_backend(name: str) -> Optional[str]:
    env = REPO_ROOT / f".env.{name}.local"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.strip().startswith("LOCAL_SERVER_PORT="):
            return f"http://localhost:{line.split('=', 1)[1].strip().strip(chr(34)).strip(chr(39))}"
    return None


def _logged_in_email(base: str) -> str:
    try:
        login = ((httpx.get(f"{base}/api/v1/cloud/status", timeout=3.0).json() or {}).get("data") or {}).get("login") or {}
    except Exception:  # noqa: BLE001
        return ""
    return str((login.get("user") or {}).get("email") or "").strip().lower() if login.get("status") == "logged_in" else ""


@pytest.fixture(scope="module")
def people(hub_base_url) -> dict:
    owner, assignee = _instance_backend(OWNER_INSTANCE), _instance_backend(ASSIGNEE_INSTANCE)
    if not owner or not assignee:
        pytest.skip(f"two instances required: `scripts/instance_ctl.sh launch {OWNER_INSTANCE}` and `{ASSIGNEE_INSTANCE}`")
    owner_email, assignee_email = _logged_in_email(owner), _logged_in_email(assignee)
    if not owner_email or not assignee_email:
        pytest.skip("both backends must be up and cloud-logged-in")
    assert owner_email != assignee_email, "two people, not one"
    return {"owner": owner, "assignee": assignee, "owner_email": owner_email, "assignee_email": assignee_email}


@pytest.fixture
def c():
    with httpx.Client(timeout=10.0) as client:
        yield client


def _u(r: httpx.Response):
    r.raise_for_status()
    j = r.json()
    if isinstance(j, dict) and j.get("status") not in (None, "SUCCESS", "success"):
        raise RuntimeError(f"{r.request.method} {r.request.url} -> {str(j)[:300]}")
    return j.get("data") if isinstance(j, dict) else j


def _list(c: httpx.Client, be: str, entity: str, **match) -> list[dict]:
    return _u(c.get(f"{be}{GRAPH}/{entity}", params={"filter": json.dumps(match), "limit": 200})) or []


def _channel(c: httpx.Client, be: str) -> str:
    rows = [r for r in _list(c, be, "data_source", provider="task_manager") if r.get("account_key") == "user:local"]
    assert len(rows) == 1, f"{be}: one Tasks channel for the person, found {rows}"
    return rows[0]["id"]


def _thread(c: httpx.Client, be: str, task_id: str) -> list[dict]:
    """The task's thread on this backend's Tasks channel: its ingested messages, newest first."""
    items = _u(c.post(f"{be}{GRAPH}/data_source/{_channel(c, be)}/items", json={"limit": 200}))["items"]
    return [i for i in items if i.get("thread_key") == task_id]


def _until(what: str, probe: Callable[[], Optional[object]]):
    deadline = time.monotonic() + CONVERGE
    last = None
    while time.monotonic() < deadline:
        last = probe()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"{what} did not happen within {CONVERGE}s (last: {last!r})")


def _says(c, be, task_id, body: str, author: Optional[str] = None, *, mine: bool = False) -> Callable[[], Optional[dict]]:
    """A probe for ``body`` in the thread, written by ``author`` — or, ``mine``, by this backend's own person
    (keyed by the channel's own address, ``user:local``, so a login change never re-attributes it)."""
    def probe():
        for item in _thread(c, be, task_id):
            who = item.get("author_external_id")
            if (item.get("body") or "").strip() == body and (
                (mine and who == "user:local") or (not mine and (author is None or who == author))
            ):
                return item
        return None
    return probe


def _task_it(c: httpx.Client, people: dict, text: str) -> dict:
    """What ``Task.fromMessage`` posts: a plain task, mine, the message's first line its title."""
    me = people["owner_email"]
    return _u(c.post(f"{people['owner']}{GRAPH}/task", json={
        "type": "task", "title": text.splitlines()[0], "description": text, "assignee": me, "reporter": me,
        "origin_conversation": f"conv-{uuid.uuid4().hex[:8]}", "origin_message": f"msg-{uuid.uuid4().hex[:8]}",
    }))


def _assign(c: httpx.Client, people: dict, task_id: str) -> None:
    _u(c.post(f"{people['owner']}{GRAPH}/task/{task_id}/assign-task", json={"email": people["assignee_email"]}))


def test_s1_task_it_opens_the_owners_thread(people, c):
    text = f"Set up the studio {uuid.uuid4().hex[:6]}\nwith the CRM"
    task = _task_it(c, people, text)
    root = _until("the owner's thread opening", _says(c, people["owner"], task["id"], text))
    assert root["external_id"] == f"{task['id']}:created"


def test_s2_assigning_gives_both_people_the_thread(people, c):
    text = f"Manage the pmf cycle {uuid.uuid4().hex[:6]}"
    task = _task_it(c, people, text)
    _assign(c, people, task["id"])
    handover = f"Assigned to {people['assignee_email']}"
    _until("the owner's thread saying it was handed over", _says(c, people["owner"], task["id"], handover))
    _until("the task reaching the assignee's thread", _says(c, people["assignee"], task["id"], handover))
    assignee_thread = _thread(c, people["assignee"], task["id"])
    assert any(i["external_id"] == f"{task['id']}:created" for i in assignee_thread), assignee_thread


def test_s3_the_assignees_status_reaches_the_owners_thread(people, c):
    task = _task_it(c, people, f"Generate the report {uuid.uuid4().hex[:6]}")
    _assign(c, people, task["id"])
    _until("the task reaching the assignee", lambda: _list(c, people["assignee"], "task", id=task["id"]))
    # The assignee moves it from their board — a hub-reflected edit of the field they own.
    _u(c.put(f"{people['assignee']}{GRAPH}/task/{task['id']}", json={"status": "in_progress"}, headers={"Hub-Reflect": "true"}))
    _until("the status change in the owner's thread",
           _says(c, people["owner"], task["id"], "Status: In progress", author=people["assignee_email"]))


def test_s4_the_owners_reply_reaches_the_assignee_in_the_thread_and_on_the_task(people, c):
    task = _task_it(c, people, f"Ship it {uuid.uuid4().hex[:6]}")
    _assign(c, people, task["id"])
    _until("the task reaching the assignee", lambda: _list(c, people["assignee"], "task", id=task["id"]))
    root = _until("the owner's thread", _says(c, people["owner"], task["id"], task["description"]))
    message = _until("the owner's root message projected", lambda: _list(c, people["owner"], "flow_message", source_item_id=root["id"]))
    conversation_id = message[0]["conversation_id"]

    reply = f"Any update? {uuid.uuid4().hex[:6]}"
    _u(c.post(f"{people['owner']}{GRAPH}/conversation/{conversation_id}/send_external", json={"text": reply}))

    _until("the reply in the assignee's thread", _says(c, people["assignee"], task["id"], reply, author=people["owner_email"]))
    comments = _list(c, people["assignee"], "comment", parent_type_id=f"task-{task['id']}")
    assert any((cm.get("data") or {}).get("text") == reply for cm in comments), comments


# ── round 2: history both read, the other direction, reopen, rename, reassignment ─────────────────────
CAROL_INSTANCE = os.environ.get("CAROL_INSTANCE", "")


def _shared(c: httpx.Client, people: dict, title: str) -> dict:
    task = _task_it(c, people, title)
    _assign(c, people, task["id"])
    _until("the task reaching the assignee", lambda: _list(c, people["assignee"], "task", id=task["id"]))
    return task


def _conversation_of(c: httpx.Client, be: str, task_id: str) -> str:
    root = _until("the thread's first message", lambda: next(
        (i for i in _thread(c, be, task_id) if i["external_id"] == f"{task_id}:created"), None))
    msg = _until("its projection", lambda: _list(c, be, "flow_message", source_item_id=root["id"]))
    return msg[0]["conversation_id"]


def test_the_owners_own_status_is_credited_to_the_owner_on_both_sides(people, c):
    task = _shared(c, people, f"Owner moves it {uuid.uuid4().hex[:6]}")
    _u(c.put(f"{people['owner']}{GRAPH}/task/{task['id']}", json={"status": "in_progress"}, headers={"Hub-Reflect": "true"}))
    _until("the owner's thread crediting the owner", _says(c, people["owner"], task["id"], "Status: In progress", mine=True))
    _until("the assignee's thread crediting the owner",
           _says(c, people["assignee"], task["id"], "Status: In progress", author=people["owner_email"]))


def test_the_assignees_reply_reaches_the_owner_in_the_thread_and_on_the_task(people, c):
    task = _shared(c, people, f"Bob answers {uuid.uuid4().hex[:6]}")
    conversation_id = _conversation_of(c, people["assignee"], task["id"])
    reply = f"On it {uuid.uuid4().hex[:6]}"
    _u(c.post(f"{people['assignee']}{GRAPH}/conversation/{conversation_id}/send_external", json={"text": reply}))
    _until("bob's reply in the owner's thread", _says(c, people["owner"], task["id"], reply, author=people["assignee_email"]))
    comments = _list(c, people["owner"], "comment", parent_type_id=f"task-{task['id']}")
    assert any((cm.get("data") or {}).get("text") == reply for cm in comments), comments


def test_done_reopened_done_is_three_messages_on_both_sides(people, c):
    task = _shared(c, people, f"Reopen {uuid.uuid4().hex[:6]}")
    for status in ("done", "in_progress", "done"):
        _u(c.put(f"{people['assignee']}{GRAPH}/task/{task['id']}", json={"status": status}, headers={"Hub-Reflect": "true"}))
    for side in ("owner", "assignee"):
        def counted(side=side):
            bodies = [i["body"] for i in _thread(c, people[side], task["id"])]
            return bodies if bodies.count("Status: Done") == 2 and bodies.count("Status: In progress") == 1 else None
        _until(f"three status messages on the {side}'s side", counted)


def test_a_rename_retitles_both_threads(people, c):
    task = _shared(c, people, f"Old title {uuid.uuid4().hex[:6]}")
    new_title = f"New title {uuid.uuid4().hex[:6]}"
    _u(c.put(f"{people['owner']}{GRAPH}/task/{task['id']}", json={"title": new_title}, headers={"Hub-Reflect": "true"}))
    for side in ("owner", "assignee"):
        cid = _conversation_of(c, people[side], task["id"])
        _until(f"the {side}'s thread renamed",
               lambda side=side, cid=cid: (_u(c.get(f"{people[side]}{GRAPH}/conversation/{cid}")) or {}).get("title") == new_title)


def test_reassigning_hands_the_thread_to_the_new_person_and_closes_it_for_the_old(people, c):
    carol = _instance_backend(CAROL_INSTANCE) if CAROL_INSTANCE else None
    carol_email = _logged_in_email(carol) if carol else ""
    if not carol_email:
        pytest.skip("set CAROL_INSTANCE to a third logged-in instance")
    task = _shared(c, people, f"Reassign {uuid.uuid4().hex[:6]}")
    _u(c.post(f"{people['owner']}{GRAPH}/task/{task['id']}/assign-task", json={"email": carol_email}))

    closing = f"Reassigned to {carol_email}"
    _until("bob's thread closing with the hand-over", _says(c, people["assignee"], task["id"], closing))
    _until("the task reaching carol's thread", lambda: [i for i in _thread(c, carol, task["id"]) if i["body"] == closing])
    # Bob is out: a later move reaches carol, never him.
    _u(c.put(f"{carol}{GRAPH}/task/{task['id']}", json={"status": "in_progress"}, headers={"Hub-Reflect": "true"}))
    _until("carol's move in the owner's thread", _says(c, people["owner"], task["id"], "Status: In progress", author=carol_email))
    time.sleep(1.0)  # bob receives nothing more: the absence is the assertion, after the owner already has it
    assert not [i for i in _thread(c, people["assignee"], task["id"]) if i["body"] == "Status: In progress"]
