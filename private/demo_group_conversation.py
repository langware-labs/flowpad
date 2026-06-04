#!/usr/bin/env python3
"""Group-conversation seeding engine (multi-participant, mid-conversation joins).

Drives the local hub directly over HTTP (the proven `demo_alice_bob_full_hub.py`
path). Each participant is a hub user backed by a running local flowpad instance;
the local bridges receive the hub fan-out and materialize the conversation.

Every participant shares all three kinds of attachment, created as REAL local
entities on that sender's own backend so the chips resolve / open:

  - asset  -> POST /graph/skill   -> TYPE_ID attachment  ("skill-<id>")
  - file   -> POST /graph/markdown -> TYPE_ID attachment  ("markdown-<id>")
             + one literal FILE attachment (exercises the type; bytes do not
             transfer over hub-direct seeding — see module note)
  - prompt -> inline PROMPT attachment ("Approve & Run" text)

Mid-conversation member adds use the hub action
  POST /graph/conversation/<id>/add_member {member_address, member_address_type}.

Scenarios (data-driven; same engine):
  s1_three : alice + dev-1, then dev-2 added mid-conversation (3 total)
  s2_five  : alice + dev-1, then dev-2, dev-3, dev-4 added gradually (5 total)

Backend ports are read from each instance's launcher registry
(~/.flow/instances/<name>/launcher.json) when present; alice (the oss instance)
defaults to :9008 / :4098.

Usage:
    uv run python private/demo_group_conversation.py --scenario s1_three

Env overrides:
    FLOWPAD_HUB_URL   default http://localhost:8093
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

import httpx

HUB = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093").rstrip("/")
FLOW_HOME = Path(os.environ.get("FLOW_HOME", str(Path.home() / ".flow")))
REPO_ROOT = "/Users/shlom/Documents/dev/flowpad-oss"


# --------------------------------------------------------------------------
# participant roster
# --------------------------------------------------------------------------
class Participant:
    def __init__(self, role: str, *, instance: Optional[str], be: str, fe: str,
                 email: str, password: str):
        self.role = role
        self.instance = instance      # launcher instance name (None for oss/alice)
        self.be = be.rstrip("/")
        self.fe = fe.rstrip("/")
        self.email = email
        self.password = password
        self.hub_id: Optional[str] = None
        self.hub_tok: Optional[str] = None

    @property
    def api(self) -> str:
        return f"{self.be}/api/v1"


def _registry_ports(instance: str) -> Optional[tuple[int, int]]:
    """Return (backend_port, frontend_port) from the launcher registry, or None."""
    reg = FLOW_HOME / "instances" / instance / "launcher.json"
    if not reg.exists():
        return None
    try:
        d = json.loads(reg.read_text())
        return int(d["backend_port"]), int(d["frontend_port"])
    except Exception:
        return None


def _make_dev(role: str, instance: str, idx: int) -> Participant:
    """Build a dev-N participant, resolving ports from the registry when up,
    else falling back to the deterministic 600X / 500X convention."""
    ports = _registry_ports(instance)
    if ports:
        be_port, fe_port = ports
    else:
        be_port, fe_port = 6000 + idx, 5000 + idx
    return Participant(
        role, instance=instance,
        be=f"http://localhost:{be_port}",
        fe=f"http://localhost:{fe_port}",
        email=f"{instance}@local.test",
        password=f"{instance}-pw-1234",
    )


def build_roster(n_devs: int) -> dict[str, Participant]:
    roster: dict[str, Participant] = {
        "alice": Participant(
            "alice", instance=None,
            be="http://localhost:9008", fe="http://localhost:4098",
            email="alice@local.test", password="alice-pw-1234",
        ),
    }
    for i in range(1, n_devs + 1):
        roster[f"dev-{i}"] = _make_dev(f"dev-{i}", f"dev-{i}", i)
    return roster


# --------------------------------------------------------------------------
# scenario timelines
# --------------------------------------------------------------------------
# Each step is one of:
#   {"op": "start", "sender": <role>, "to": <role>, "text": ..., "attach": [...]}
#   {"op": "msg",   "sender": <role>, "text": ..., "attach": [...]}
#   {"op": "add",   "adder": <role>, "member": <role>}     <- mid-conversation join
# "attach" is any subset of ["asset", "file", "prompt", "url", "repo"].

def scenario_s1_three() -> tuple[int, list[dict]]:
    timeline = [
        {"op": "start", "sender": "alice", "to": "dev-1",
         "text": "dev-1 — checkout-api p99 jumped 80ms -> 4.2s at 14:03 UTC, error "
                 "rate flat. Incident report + the cart_service file attached. Run "
                 "the triage prompt and tell me what you see.",
         "attach": ["asset", "file", "prompt", "url"]},

        {"op": "msg", "sender": "dev-1",
         "text": "Got it. Latency-scales-with-cart-size = N+1 fingerprint. Sharing my "
                 "trace-n-plus-one skill + the trace dump file. Approve & run the "
                 "analyzer prompt against the three slow traces.",
         "attach": ["asset", "file", "prompt"]},

        {"op": "msg", "sender": "alice",
         "text": "Ran it. Root cause confirmed: enrich_cart_lines() per-line lookup. "
                 "Fix-plan spec attached.",
         "attach": ["asset"]},

        # --- mid-conversation: pull in dev-2 ---
        {"op": "add", "adder": "alice", "member": "dev-2"},

        {"op": "msg", "sender": "dev-2",
         "text": "Joining late — caught up on the thread. I own the canary tooling. "
                 "Sharing the rollback runbook (file), my canary-guard skill (asset), "
                 "and an Approve & Run prompt to roll v2.41 back to v2.40 now.",
         "attach": ["asset", "file", "prompt", "repo"]},

        {"op": "msg", "sender": "dev-1",
         "text": "Rollback prompt looks right. Also sharing the regression-test prompt "
                 "so this can't ship again.",
         "attach": ["prompt"]},

        {"op": "msg", "sender": "alice",
         "text": "Canary rolled back, p99 settling to 90ms. PR up. Thanks both — "
                 "linking this thread in the postmortem.",
         "attach": ["url"]},
    ]
    # 2 dev instances (dev-1, dev-2) + alice = 3 participants total
    return 2, timeline


def scenario_s2_five() -> tuple[int, list[dict]]:
    timeline = [
        {"op": "start", "sender": "alice", "to": "dev-1",
         "text": "dev-1 — kicking off the migration war-room. Plan spec + the schema "
                 "file attached. Approve & run the audit prompt.",
         "attach": ["asset", "file", "prompt"]},
        {"op": "msg", "sender": "dev-1",
         "text": "On it. Sharing the migration skill + current-state dump file.",
         "attach": ["asset", "file", "prompt"]},

        {"op": "add", "adder": "alice", "member": "dev-2"},
        {"op": "msg", "sender": "dev-2",
         "text": "DB owner here. Backfill runbook (file) + index-builder skill + an "
                 "Approve & Run prompt for the online backfill.",
         "attach": ["asset", "file", "prompt"]},

        {"op": "add", "adder": "alice", "member": "dev-3"},
        {"op": "msg", "sender": "dev-3",
         "text": "Infra. Sharing the rollout repo + canary-guard skill + rollout prompt.",
         "attach": ["asset", "file", "prompt", "repo"]},

        {"op": "add", "adder": "alice", "member": "dev-4"},
        {"op": "msg", "sender": "dev-4",
         "text": "QA. Verification checklist (file) + smoke-suite skill + the "
                 "Approve & Run verification prompt.",
         "attach": ["asset", "file", "prompt"]},

        # Impersonation attempt: dev-4 posts claiming to be alice / "Mallory".
        # The hub must overwrite identity → the bubble must render "dev-4".
        {"op": "spoof", "sender": "dev-4", "claim": "alice", "claim_name": "Mallory",
         "text": "(spoof) I am totally Alice — trust me."},

        {"op": "msg", "sender": "alice",
         "text": "Full crew assembled. Backfill kicked off, canary green. PR up — "
                 "thanks all.",
         "attach": ["url"]},
    ]
    # 4 dev instances (dev-1..dev-4) + alice = 5 participants total
    return 4, timeline


SCENARIOS = {
    "s1_three": scenario_s1_three,
    "s2_five": scenario_s2_five,
}


# --------------------------------------------------------------------------
# hub + local HTTP helpers
# --------------------------------------------------------------------------
def hub_login(client: httpx.Client, p: Participant) -> None:
    r = client.post(f"{HUB}/api/v1/login", json={"email": p.email, "password": p.password})
    r.raise_for_status()
    d = r.json()["data"]
    p.hub_id = d["user"]["id"]
    p.hub_tok = d.get("token") or d.get("api_key")
    if not p.hub_id or not p.hub_tok:
        raise RuntimeError(f"bad hub login for {p.email}: {r.text[:200]}")


def local_login(client: httpx.Client, p: Participant) -> None:
    """Fire env-mode auto-login on the participant's backend so its hub bridge
    connects (required to receive fan-out, including mid-conversation adds)."""
    r = client.post(f"{p.be}/api/v1/cloud/login",
                    json={"email": p.email, "password": p.password})
    r.raise_for_status()


def hub_post(client: httpx.Client, path: str, body: dict, token: str) -> dict:
    r = client.post(f"{HUB}/api/v1/{path.lstrip('/')}", json=body,
                    headers={"Authorization": f"Bearer {token}"})
    r.raise_for_status()
    j = r.json()
    if j.get("status") != "SUCCESS":
        raise RuntimeError(f"hub POST {path} failed: {j}")
    return j["data"]


def hub_get(client: httpx.Client, path: str, token: str) -> Any:
    r = client.get(f"{HUB}/api/v1/{path.lstrip('/')}",
                   headers={"Authorization": f"Bearer {token}"})
    r.raise_for_status()
    return r.json().get("data")


def local_create(client: httpx.Client, p: Participant, kind: str, payload: dict) -> str:
    """Create a real local entity on the sender's backend; return its id."""
    r = client.post(f"{p.api}/graph/{kind}", json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"create {kind} on {p.role} failed: {r.status_code} {r.text[:200]}")
    return ((r.json() or {}).get("data") or {}).get("id")


def add_member_to_conversation(client: httpx.Client, conv_id: str,
                               adder: Participant, member: Participant) -> None:
    """Add ``member`` to an existing conversation mid-stream.

    The hub has no single add-member action; membership flows through the
    invitation→accept→join pattern (verified against the live hub + the
    canonical client in flow_sdk Conversation.share / _hub_accept_invitation):
      1. adder  POST conversation/<id>/members {recipient_email,invitation_targets}
      2. member GET  invitation/pending                       -> find inv id
      3. member GET  members/accept?invitation-id=<id>        -> grants role
      4. member POST conversation/<id>/join                   -> participant
    """
    # 1. invite — body is a MembershipRequest: recipient_email + invitation_targets
    r = client.post(
        f"{HUB}/api/v1/graph/conversation/{conv_id}/members",
        json={
            "recipient_email": member.email,
            "invitation_targets": [
                {"typeid": f"conversation-{conv_id}", "role": "member"},
            ],
        },
        headers={"Authorization": f"Bearer {adder.hub_tok}"},
    )
    r.raise_for_status()

    # 2. member finds the pending invitation for THIS conversation
    r = client.get(f"{HUB}/api/v1/graph/invitation/pending",
                   headers={"Authorization": f"Bearer {member.hub_tok}"})
    r.raise_for_status()
    pend = (r.json() or {}).get("data") or []
    chosen = None
    for it in pend if isinstance(pend, list) else []:
        base = it.get("invitation") if isinstance(it, dict) and "invitation" in it else it
        iid = (base or {}).get("id")
        convt = (it.get("conversation") or {}) if isinstance(it, dict) else {}
        if convt.get("id") == conv_id:
            chosen = iid
            break
        if chosen is None:
            chosen = iid  # fallback: newest pending
    if not chosen:
        raise RuntimeError(f"no pending invitation found for {member.email} on {conv_id}")

    # 3. accept (GET, grants role) + 4. join (adds to participants)
    r = client.get(f"{HUB}/api/v1/graph/members/accept?invitation-id={chosen}",
                   headers={"Authorization": f"Bearer {member.hub_tok}"})
    r.raise_for_status()
    r = client.post(f"{HUB}/api/v1/graph/conversation/{conv_id}/join",
                    json={}, headers={"Authorization": f"Bearer {member.hub_tok}"})
    r.raise_for_status()


# --------------------------------------------------------------------------
# attachment builder — creates real local entities per requested kind
# --------------------------------------------------------------------------
_ASSET_SKILL = {
    "trace-n-plus-one": "Groups service-log queries by trace_id, surfaces N+1 repeats, "
                        "correlates slow traces with deploy headers.",
    "canary-guard": "Watches canary p99/error-rate vs baseline and auto-recommends "
                    "rollback when the regression crosses threshold.",
    "regression-test-coverage": "Generates property-based regression tests for a "
                                "function symbol from its call sites + type signatures.",
    "migration-auditor": "Audits a schema migration for unsafe column drops, missing "
                         "backfills, and lock-holding statements.",
    "index-builder": "Builds online indexes with progress reporting and lock-free "
                     "CONCURRENTLY semantics.",
    "smoke-suite": "Runs the post-deploy smoke suite and reports pass/fail per surface.",
}

_FILE_DOC = (
    "# {title}\n\n"
    "Shared by **{role}** in the group conversation.\n\n"
    "```\n{body}\n```\n"
)

_PROMPT_TEXT = {
    "alice": "Run triage on checkout-api logs 14:00Z-14:10Z, filter x-deploy-id="
             "v2.41-canary, surface top-3 N+1 candidates with file:line.",
    "dev-1": "Run trace-n-plus-one against tr_a1b2, tr_c3d4, tr_e5f6 and emit the "
             "batched-alternative for the worst offender.",
    "dev-2": "Roll checkout-api canary back from v2.41 to v2.40 now; confirm p99 "
             "returns under 150ms before reporting done.",
    "dev-3": "Execute the staged rollout: 10% -> watch 10m -> 50% -> watch 10m -> 100%.",
    "dev-4": "Run the verification checklist against staging and the canary cohort; "
             "fail loudly on any SEV regression.",
    "_default": "Approve & run this step, then report the result back to the thread.",
}


def build_attachments(client: httpx.Client, p: Participant, kinds: list[str], seq: int) -> list[dict]:
    """Create the needed local entities on p's backend and return hub attachment dicts."""
    atts: list[dict] = []
    for kind in kinds:
        if kind == "asset":
            name = list(_ASSET_SKILL)[(seq) % len(_ASSET_SKILL)]
            sid = local_create(client, p, "skill",
                               {"name": f"{name}-{p.role}-{seq}", "description": _ASSET_SKILL[name]})
            atts.append({"attachment_type": "type_id", "data": f"skill-{sid}"})
        elif kind == "file":
            title = f"{p.role}-notes-{seq}"
            content = _FILE_DOC.format(
                title=title, role=p.role,
                body=f"step {seq} payload from {p.role}\nline-A\nline-B\nline-C")
            mid = local_create(client, p, "markdown", {"title": title, "content": content})
            atts.append({"attachment_type": "type_id", "data": f"markdown-{mid}"})
            # literal FILE attachment to exercise the type (metadata-only over hub-direct)
            atts.append({"attachment_type": "file", "data": f"{title}.md"})
        elif kind == "prompt":
            atts.append({"attachment_type": "prompt",
                         "data": _PROMPT_TEXT.get(p.role, _PROMPT_TEXT["_default"])})
        elif kind == "url":
            atts.append({"attachment_type": "url",
                         "data": "https://datadog.example.com/dash/checkout-latency"
                                 "?from=14:00&to=15:00&deploy=v2.41-canary"})
        elif kind == "repo":
            atts.append({"attachment_type": "repo", "data": REPO_ROOT})
    return atts


# --------------------------------------------------------------------------
# engine
# --------------------------------------------------------------------------
def run(scenario_key: str) -> int:
    n_devs, timeline = SCENARIOS[scenario_key]()
    roster = build_roster(n_devs)

    print(f"[setup] scenario={scenario_key}  hub={HUB}")
    for role, p in roster.items():
        print(f"  {role:7s} be={p.be:24s} fe={p.fe:24s} user={p.email}")
    print()

    with httpx.Client(timeout=30.0) as client:
        # 1. local auto-login (connect every bridge) + hub login (ids/tokens)
        for role, p in roster.items():
            try:
                local_login(client, p)
            except Exception as e:
                print(f"  ! local_login {role} failed: {e}")
            hub_login(client, p)
        print("[setup] hub ids:")
        for role, p in roster.items():
            print(f"  {role:7s} {p.hub_id}")
        print()

        alice = roster["alice"]
        proj = hub_post(client, "/graph/project",
                        {"name": f"group-demo-{scenario_key}-{int(time.time())}"}, alice.hub_tok)
        proj_id = proj["id"]
        print(f"[setup] hub project: {proj_id}")
        print()

        conv_id: Optional[str] = None
        seq = 0
        active = {"alice"}  # roles currently in the conversation

        for step in timeline:
            op = step["op"]
            if op == "start":
                sender = roster[step["sender"]]
                to = roster[step["to"]]
                atts = build_attachments(client, sender, step.get("attach", []), seq)
                body = {
                    "text": step["text"],
                    "receiver_address": to.hub_id,
                    "receiver_address_type": "id",
                    "attachment": atts,
                }
                conv = hub_post(client, f"/graph/project/{proj_id}/start_guest_conversation",
                                body, sender.hub_tok)
                conv_id = conv["id"]
                active.add(step["to"])
                print(f"  [start ] {step['sender']:6s} -> {step['to']:6s}  "
                      f"{_att_glyph(atts)}  conv={conv_id}")

            elif op == "add":
                adder = roster[step["adder"]]
                member = roster[step["member"]]
                add_member_to_conversation(client, conv_id, adder, member)
                active.add(step["member"])
                print(f"  [+add  ] {step['adder']:6s} added {step['member']:6s}  "
                      f"-> participants={sorted(active)}")

            elif op == "msg":
                sender = roster[step["sender"]]
                if step["sender"] not in active:
                    print(f"  ! {step['sender']} not yet a participant — skipping msg")
                    continue
                atts = build_attachments(client, sender, step.get("attach", []), seq)
                hub_post(client, f"/graph/conversation/{conv_id}/add_message",
                         {"text": step["text"], "attachment": atts}, sender.hub_tok)
                print(f"  [msg   ] {step['sender']:6s}          {_att_glyph(atts)}")

            elif op == "spoof":
                # Identity-spoof attempt: `sender` (the authenticated caller)
                # posts add_message with a FAKE sender_id (impersonating
                # `claim`) and a FAKE sender_name. A correct hub overwrites both
                # to the authenticated user, so the UI must render `sender`'s
                # real name — never `claim_name`, never "unknown".
                sender = roster[step["sender"]]
                claim = roster[step["claim"]]
                hub_post(client, f"/graph/conversation/{conv_id}/add_message",
                         {"text": step["text"],
                          "sender_id": claim.hub_id,           # bogus
                          "sender_name": step["claim_name"]},  # bogus
                         sender.hub_tok)
                print(f"  [SPOOF ] {step['sender']:6s} claims {step['claim']}/"
                      f"{step['claim_name']!r} (hub must show {step['sender']})")

            seq += 1
            time.sleep(0.05)

        print()
        # verify on the hub
        msgs = hub_get(client, f"/graph/conversation/{conv_id}/flow_message", alice.hub_tok)
        hub_count = len(msgs or [])
        print(f"[verify] hub message count: {hub_count}")
        print()

        # dispatch per-backend catch-up fetch on every participant
        print("[sync] dispatching conversation-list on each participant backend…")
        for role, p in roster.items():
            try:
                client.post(f"{p.be}/api/v1/graph/conversation-list", json={})
            except Exception as e:
                print(f"  ! {role} conversation-list failed: {e}")

        # Converge: late joiners backfill pre-join history via an async catch-up
        # job, so re-dispatch + re-check until every local backend matches its
        # hub-visible count (bounded rounds) — observing the condition, not
        # sleeping a fixed interval.
        def _hub_vis(p: Participant) -> int:
            try:
                r = client.get(f"{HUB}/api/v1/graph/conversation/{conv_id}/flow_message",
                               headers={"Authorization": f"Bearer {p.hub_tok}"})
                return len((r.json() or {}).get("data") or []) if r.status_code == 200 else -1
            except Exception:
                return -1

        def _loc(p: Participant) -> int:
            try:
                r = client.get(f"{p.be}/api/v1/graph/conversation/{conv_id}/flow_message")
                return len((r.json() or {}).get("data") or [])
            except Exception:
                return -1

        # First, one conversation-list per participant so each backend creates
        # the local Conversation row (late joiners materialize it from the hub
        # listing / invitation). conversation-message-sync is then gated on that
        # row existing.
        for role, p in roster.items():
            try:
                client.post(f"{p.be}/api/v1/graph/conversation-list", json={})
            except Exception:
                pass
        time.sleep(2)

        # conversation-message-sync is the UNCONDITIONAL per-conversation
        # catch-up (awaits _fetch_conversation_messages directly). Unlike
        # conversation-list, it is NOT gated by the parent-updated_date LWW
        # check, so it reliably backfills a late joiner's pre-join history even
        # after the conv metadata was already upserted.
        for round_i in range(12):
            for role, p in roster.items():
                try:
                    client.post(f"{p.be}/api/v1/graph/conversation-message-sync",
                                json={"conversation_id": conv_id})
                except Exception:
                    pass
            time.sleep(2)
            pending = [r for r, p in roster.items() if _loc(p) < _hub_vis(p)]
            if not pending:
                print(f"[sync] converged after {round_i + 1} round(s)")
                break
            print(f"[sync] round {round_i + 1}: lagging -> {pending}")

        # For each participant: how many messages the HUB exposes to them
        # (role-gated; late joiners see only post-join fan-out) and how many
        # their LOCAL backend has materialized. "synced" == local >= hub-visible.
        print()
        print("[sync] per-participant message counts (hub-visible vs local):")
        summary: dict[str, Any] = {
            "scenario": scenario_key, "conversation_id": conv_id,
            "hub_total": hub_count, "participants": sorted(active),
            "per_user": {},
        }
        ok = True
        for role, p in roster.items():
            try:
                rh = client.get(f"{HUB}/api/v1/graph/conversation/{conv_id}/flow_message",
                                headers={"Authorization": f"Bearer {p.hub_tok}"})
                hv = len((rh.json() or {}).get("data") or []) if rh.status_code == 200 else -1
            except Exception:
                hv = -1
            try:
                rl = client.get(f"{p.be}/api/v1/graph/conversation/{conv_id}/flow_message")
                lc = len((rl.json() or {}).get("data") or [])
            except Exception:
                lc = -1
            synced = lc >= hv and hv >= 0
            if not synced:
                ok = False
            summary["per_user"][role] = {"hub_visible": hv, "local": lc, "synced": synced}
            print(f"  {role:7s} hub-visible={hv:2d}  local={lc:3d}  "
                  f"[{'ok' if synced else 'LAGGING'}]")

        out = FLOW_HOME / f"group-{scenario_key}-summary.json"
        out.write_text(json.dumps(summary, indent=2))

        print()
        print("=" * 70)
        print(f"GROUP CONVERSATION SEEDED  ({hub_count} messages, "
              f"{len(active)} participants)")
        print(f"  conversation id : {conv_id}")
        for role, p in roster.items():
            print(f"  {role:7s} {p.fe}/dock/conversation/{conv_id}")
        print(f"  summary json    : {out}")
        print("=" * 70)
        return 0 if ok else 2


def _att_glyph(atts: list[dict]) -> str:
    g = {"type_id": "📎", "file": "📄", "prompt": "⌨", "url": "🔗", "repo": "📁"}
    return "".join(g.get(a["attachment_type"], "?") for a in atts) or "—"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="s1_three", choices=list(SCENARIOS))
    args = ap.parse_args()
    try:
        return run(args.scenario)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"\nFAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
