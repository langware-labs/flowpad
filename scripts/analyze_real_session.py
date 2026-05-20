"""Run the system 'analyze' agent on a real Claude session JSONL.

Pure-Python entrypoint that mirrors the
``test_agentic_process_analyze_with_agent`` long-test pattern but feeds it a
**real** session from ``~/.claude/projects/`` instead of the SAMPLE_SESSION
fixture. Uses an isolated temp SQLite so it doesn't fight the running dev
backend over file locks.

Usage::

    uv run python scripts/analyze_real_session.py [<jsonl-path>]

Without an argument, picks a small recent session (5-50 KB) so the agent
finishes in a couple of minutes.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path


async def main(target: Path) -> int:
    # Isolated DB so we don't lock the running dev backend's sqlite.
    from flow_sdk.db.db_entity import DBEntity
    from flow_sdk.db.db_relationship import DBRelationship
    from flow_sdk.db.drivers.db_driver import DBConfig, _driver_instances
    from flow_sdk.db.drivers.sqlite import SQLiteDBDriver

    tmp_root = Path(tempfile.mkdtemp(prefix="analyze-session-"))
    tmp_db = tmp_root / "analysis.db"
    workdir = tmp_root / "workdir"
    workdir.mkdir()
    driver = SQLiteDBDriver(DBConfig(database=str(tmp_db)))
    _driver_instances["sqlite"] = driver
    DBEntity._db = driver
    DBRelationship._db = driver
    await driver.open()

    try:
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.builtin.faas.compute_node import ComputeNode
        from flow_sdk.builtin.project import Project
        from flow_sdk.builtin.user import User
        from flow_sdk.config import ComputeProviderType, StorageProvider
        from flow_sdk.flowpad_types.enums import WorkerType
        from flow_sdk.flowpad_types.runtime_environment import RuntimeEnvironment
        from flow_sdk.fs_records.agent_record import AgentRecord
        from flow_sdk.server.routes.bootstrap import _new_provider_id

        # Prerequisites the AgenticProcess driver expects (mirrors the
        # ``local_project`` + ``local_compute_node`` fixtures used by the
        # canonical analyze test). Create idempotently so reruns work.
        user = await User.get_by_uname("local")
        if user is None:
            user = await User(uname="local", name="local").save()

        if (await Project.get_by_uname("local")) is None:
            await Project(uname="local", name="local", fs_storage_mount_path=str(workdir)).save()

        if (await ComputeNode.get_by_uname("local")) is None:
            await ComputeNode(
                uname="local",
                name="@local",
                runtime=RuntimeEnvironment(name="local_desktop_runtime"),
                node_provider_type=ComputeProviderType.LOCAL_MACHINE,
                fs_storage_provider=StorageProvider.SANDBOX,
                fs_storage_mount_path="/",
                visitor_role="owner",
                node_provider_id=_new_provider_id("name"),
            ).save(owner=user)

        agent = AgentRecord.load_system_agent("analyze")
        if agent is None:
            print("ERR: analyze system agent not found", file=sys.stderr)
            return 2

        session_id = target.stem
        instruction = (
            "Use the 'analyze' sub-agent to analyze the following Claude Code session.\n\n"
            f"Session ID: {session_id}\n"
            f"Session JSONL path: {target}\n\n"
            "Read the JSONL and extract real wisdom: actual mistakes the user/agent made,\n"
            "misunderstandings, inefficient patterns, and clear automation opportunities.\n"
            "Be specific — reference actual turns when possible. Skip generic advice.\n"
        )

        print(f"== Session: {target}")
        print(f"== Size: {target.stat().st_size:,} bytes")
        print(f"== Embedded agent: {agent.name}")
        print()

        process = await AgenticProcess(worker_type=WorkerType.CLAUDE_CODE, workdir=str(workdir)).save()
        process.load_embedded_agent(agent)
        print("== prompting agent (this can take 1–3 min)…", flush=True)
        await process.prompt(instruction)
        print("== prompt returned, streaming transcript…", flush=True)

        # Live print of the transcript so we can watch wisdom emerge.
        async for entry in process.stream_transcript(timeout=300):
            t = entry.get("type", "?")
            if t == "assistant":
                msg = entry.get("message", {})
                content = msg.get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if block.get("type") == "text":
                            text = block["text"][:200].replace("\n", " ")
                            print(f"  [say] {text}")
                        elif block.get("type") == "tool_use":
                            print(f"  [tool: {block.get('name')}]")
            elif t == "user":
                pass  # skip echoes
            else:
                print(f"  [{t}]")

        # Read back analysis.json (the analyze agent contract).
        workdir = Path(process.workdir or "")
        if not workdir.exists():
            print(f"\nNO workdir on disk: {workdir}", file=sys.stderr)
            return 3
        json_outs = list(workdir.rglob("analysis.json"))
        md_outs = list(workdir.rglob("analysis.md"))
        print()
        print(f"== workdir: {workdir}")
        print(f"== json files: {len(json_outs)}, md files: {len(md_outs)}")

        if json_outs:
            data = json.loads(json_outs[0].read_text())
            issues = data.get("issues", [])
            print(f"\n== analysis.json — {len(issues)} issue(s)")
            for i, issue in enumerate(issues, 1):
                print(f"\n  {i}. [{issue.get('category', '?')}] {issue.get('title', '(no title)')}")
                desc = (issue.get("description") or "").strip()
                if desc:
                    for line in desc.splitlines()[:5]:
                        print(f"     {line}")
        if md_outs:
            print(f"\n== analysis.md preview (first 2 KB)")
            print(md_outs[0].read_text()[:2000])

        return 0 if json_outs else 1
    finally:
        await driver.close()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = Path(sys.argv[1]).expanduser().resolve()
    else:
        # Pick a small-ish, recent session so the agent finishes promptly.
        sessions = sorted(
            (Path.home() / ".claude" / "projects").rglob("*.jsonl"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        target = next(
            (p for p in sessions if 5_000 < p.stat().st_size < 30_000),
            None,
        )
        if target is None:
            print("No suitable session JSONL found", file=sys.stderr)
            sys.exit(2)
    sys.exit(asyncio.run(main(target)))
