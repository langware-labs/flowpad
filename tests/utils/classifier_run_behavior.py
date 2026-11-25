"""The ``stream-inbox-classifier`` run with no model: a ``MockDriver`` behavior (``MOCK_BEHAVIOR``).

It does what the skill's main agent does, with the skill's own ``stream_inbox_ctl.py``: read the tree and
each conversation, assemble one proposal, ``check`` -> ``validate`` -> ``submit``, and write the reference
where the run was told to. Only the reading is scripted: the conversation whose id sorts first gets a NEW
tag (``<root>.sales.demo``, so the proposal carries a tree change), the others ``<root>.sales.intro``.
Every other turn answers like the plain mock.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

from flow_sdk.stream_inbox.classification import review_app

CTL = review_app().parent / "scripts" / "stream_inbox_ctl.py"
_RECEIPT = re.compile(r"exactly this path:\s*\n\s*(\S[^\n]*)")


def _conversations(found) -> list[str]:
    """The ``conversations`` list, wherever the mounted input keeps it."""
    if isinstance(found, dict):
        if isinstance(found.get("conversations"), list):
            return [str(i) for i in found["conversations"]]
        found = list(found.values())
    for item in found if isinstance(found, list) else []:
        if ids := _conversations(item):
            return ids
    return []


async def classifier_run(turn) -> str:
    receipt = _RECEIPT.search(turn.prompt)
    if receipt is None or "stream-inbox-classifier" not in turn.prompt:
        return f"Mock reply: {turn.prompt}"

    async def ctl(*args: str) -> dict:
        run = await asyncio.create_subprocess_exec(sys.executable, str(CTL), *args, stdout=asyncio.subprocess.PIPE)
        out = (await run.communicate())[0].decode()
        turn._tool("Bash", {"command": "stream_inbox_ctl.py " + " ".join(args)}, out)
        answer = json.loads(out)
        if not answer.get("ok") or answer.get("fits") is False:
            raise RuntimeError(f"stream_inbox_ctl {args[0]}: {out}")
        return answer

    ids = sorted({i for path in sorted(turn.input_dir.rglob("*.json")) for i in _conversations(json.loads(path.read_text()))})
    root = (await ctl("tree"))["root"]
    new, known = f"{root}.sales.demo", f"{root}.sales.intro"
    rows = []
    for at, conversation in enumerate(ids):
        read = await ctl("conversation", conversation)
        proposed = [new if at == 0 else known]
        rows.append({"conversation_id": read["conversation_id"], "message_id": read["message_id"], "title": read["title"],
                     "before": read["before"], "proposed": proposed, "reason": "Scripted reading.",
                     "action": "keep" if read["before"] == proposed else "change" if read["before"] else "apply"})
    value = {"root": root, "conversations": rows, "tree_changes": [
        {"op": "added", "tag": new, "meaning": "Asks for a product demo", "reason": "No tag fits a demo request.", "asked_by": 1}]}
    proposal = turn.write(Path(receipt.group(1).strip()).with_name("proposal.json"), json.dumps(value))
    await ctl("check", str(proposal))
    await ctl("validate", str(proposal))
    ref = (await ctl("submit", str(proposal)))["ref"]
    turn.write(receipt.group(1).strip(), json.dumps({
        "status": "done", "summary": f"Classified {len(rows)} conversations.", "data": {"value": {"ref": ref, "conversations": len(rows)}}}))
    return f"{len(rows)} conversations, 1 tree change: added {new}."
