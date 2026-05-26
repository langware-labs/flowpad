#!/usr/bin/env python3
"""Demo: index our own `docs/` tree via the MarkdownIndex pipeline.

Drives the same code path the LLM Indexers UI lens uses:

  1. POST  /api/v1/graph/markdown_index    → create entity for vault_root
  2. POST  /api/v1/graph/agentic_process   → spawn rebuild (kind=markdown_index_rebuild)
  3. poll  /api/v1/graph/agentic_process/<id>   → wait for STOPPED
  4. read  every generated <folder>/index.md    → print Self-Summary

Run from repo root:

    python scripts/demo_markdown_index.py

Flags:
    --vault PATH         vault root to index (default: ./docs)
    --copy-to DIR        copy the vault to DIR first and index that instead
                         (keeps your real docs/ clean; recommended for demos)
    --api  URL           backend base URL (default: http://localhost:9008)
    --skill-dir PATH     absolute path to the markdown_index skill dir
                         (default: <repo>/flow_sdk/system_projects/flowpad_assistant/.claude/skills/markdown_index)
    --timeout SECONDS    max poll wait (default: 600)
    --keep-entity        don't DELETE the MarkdownIndex entity at the end
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SKILL_DIR = (
    REPO_ROOT
    / "flow_sdk"
    / "system_projects"
    / "flowpad_assistant"
    / ".claude"
    / "skills"
    / "markdown_index"
)


def http(method: str, url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except HTTPError as e:
        sys.exit(f"HTTP {e.code} on {method} {url}\n{e.read().decode('utf-8', 'replace')}")
    except URLError as e:
        sys.exit(f"backend unreachable at {url}: {e.reason}")
    if not raw:
        return {}
    return json.loads(raw)


def fmt(s: str, n: int = 70) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--vault", type=Path, default=REPO_ROOT / "docs")
    p.add_argument("--copy-to", type=Path, default=None)
    p.add_argument("--api", default="http://localhost:9008")
    p.add_argument("--skill-dir", type=Path, default=DEFAULT_SKILL_DIR)
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--keep-entity", action="store_true")
    args = p.parse_args()

    vault = args.vault.resolve()
    if not vault.is_dir():
        sys.exit(f"vault not a directory: {vault}")

    if args.copy_to:
        dst = args.copy_to.resolve()
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(vault, dst)
        vault = dst
        print(f"📋 copied vault → {vault}")

    api = args.api.rstrip("/")
    skill_dir = args.skill_dir.resolve()
    if not (skill_dir / "SKILL.md").is_file():
        sys.exit(f"skill dir missing SKILL.md: {skill_dir}")

    # --- 0. sanity
    bs = http("GET", f"{api}/api/v1/graph/bootstrap")
    if bs.get("status") != "SUCCESS":
        sys.exit(f"bootstrap failed: {bs}")
    schema = http("GET", f"{api}/api/v1/agent/schema/markdown_index")
    if not schema.get("type", {}).get("has_entity_cls"):
        sys.exit("markdown_index entity not registered — restart your backend")
    print(f"✅ backend up at {api}  · markdown_index entity registered")

    # --- 1. count what we're about to chew through
    md_files = list(vault.rglob("*.md"))
    folders = {p.parent for p in md_files}
    print(f"📂 vault: {vault}")
    print(f"   {len(md_files)} markdown files across {len(folders)} folders")
    print(f"   cold build ≈ {len(md_files)} file summaries + {len(folders)} folder assemblies")

    # --- 2. create entity
    asset_ref = vault / "index.md"
    create = http(
        "POST",
        f"{api}/api/v1/graph/markdown_index",
        {
            "vault_root": str(vault),
            "asset_ref": str(asset_ref),
            "name": vault.name,
        },
    )
    entity = create["data"]
    eid = entity["id"]
    typeid = f"markdown_index-{eid}"
    print(f"📝 created MarkdownIndex {typeid}")

    # --- 3. spawn rebuild AgenticProcess (same shape LlmIndexersViewer uses)
    instruction = "\n".join([
        f"Rebuild MarkdownIndex `{typeid}`.",
        f"ROOT_PATH={vault}",
        f"MARKDOWN_INDEX_TYPEID={typeid}",
        f"SKILL_DIR={skill_dir}",
        f"FORCE=false",
        "",
        "Follow the markdown_index skill protocol: run plan.py, summarise stale "
        "files, assemble stale folders post-order.",
    ])
    cli_config = {
        "permission_mode": "bypassPermissions",
        "print_mode": True,
        "output_format": "stream-json",
        "verbose": True,
    }
    spawn = http(
        "POST",
        f"{api}/api/v1/graph/agentic_process",
        {
            "cli_config": cli_config,
            "context_data": {
                "kind": "markdown_index_rebuild",
                "markdown_index_id": eid,
            },
            "workdir": str(vault),
            "visible": False,
            "target_typeid_str": typeid,
            "process_type": "execution",
        },
    )
    pid = spawn["data"]["id"]
    print(f"🚀 spawned AgenticProcess {pid} — sending prompt…")

    # Issue the prompt (same endpoint LlmIndexersViewer triggers via process.prompt)
    http("POST", f"{api}/api/v1/graph/agentic_process/{pid}/prompt",
         {"prompt": instruction})

    # --- 4. poll
    print(f"⏳ polling (timeout {args.timeout}s)…  open the lens to watch live:")
    print(f"   http://localhost:4098/dock/lens/fs-records/llm-indexers/")
    start = time.time()
    last = ""
    while True:
        elapsed = int(time.time() - start)
        if elapsed >= args.timeout:
            print(f"\n⏱  timed out after {elapsed}s (process still running)")
            break
        proc = http("GET", f"{api}/api/v1/graph/agentic_process/{pid}")["data"]
        status = proc.get("status", "?")
        line = f"   t={elapsed:>3}s  status={status}"
        if line != last:
            print(line)
            last = line
        if status in ("stopped", "STOPPED", "completed", "failed", "error"):
            break
        time.sleep(5)

    # --- 5. report on generated index.md files
    print()
    print("=" * 78)
    print(f"📑 generated index.md files under {vault}")
    print("=" * 78)
    generated = sorted(vault.rglob("index.md"))
    if not generated:
        print("(none — rebuild did not produce any index.md files)")
    for idx in generated:
        rel = idx.relative_to(vault)
        text = idx.read_text(encoding="utf-8", errors="replace")
        # Extract Self-Summary block (greedy through next ## header)
        ss = ""
        if "## Self-Summary" in text:
            ss = text.split("## Self-Summary", 1)[1]
            ss = ss.split("\n##", 1)[0].strip()
            ss = ss.lstrip("> ").strip()
        print(f"\n  📄 {rel}")
        if ss:
            print(f"     {fmt(ss, 110)}")
        else:
            print("     (no Self-Summary block)")

    # --- 6. cleanup
    if not args.keep_entity:
        http("DELETE", f"{api}/api/v1/graph/markdown_index/{eid}")
        print(f"\n🗑  deleted MarkdownIndex {typeid}")
    else:
        print(f"\n💾 kept MarkdownIndex {typeid} (--keep-entity)")
    if args.copy_to:
        print(f"   vault copy preserved at {vault}")
    else:
        print(f"   ⚠ index.md files are written in-place under {vault}")
        print(f"     to revert: cd {vault} && git checkout -- .")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
