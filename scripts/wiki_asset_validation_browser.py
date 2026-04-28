"""Browser-driven validation that the wiki editor renders the real file body
for every asset-backed type. Complement to wiki_asset_validation.py (which
checks the API layer); this checks the rendered Milkdown surface end-to-end.

Strategy per asset type:
  1. Pick a sample entity with a non-empty asset_ref (skip system).
  2. Navigate to /dock/assets/editor/<type>/<vfsPath> on the running UI.
  3. Wait for the Milkdown editor textbox to render.
  4. Extract the rendered body text from the editor DOM.
  5. Compare to the on-disk file body (after stripping YAML frontmatter).
  6. Assert that the rendered body is non-empty when the file is non-empty.

Requires: `pip install playwright && playwright install chromium`

The same checks can be executed interactively via debugMCP — see the URL list
the script prints when invoked with --list. Pass that list to a debugMCP-
driven session if you'd rather drive the browser through Claude's
mcp__debugMcp__browser_navigate / browser_evaluate tools.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

API_ROOT = "http://localhost:9008"
UI_ROOT = "http://localhost:4098"

ASSET_TYPES = [
    "agent",
    "skill",
    "workflow",
    "markdown",
    "plan",
    "claude_md",
    "claude_memory",
]


@dataclass
class Sample:
    type: str
    id: str
    name: str
    asset_ref: str
    url: str
    file_path: Path

    def disk_body(self) -> str:
        """File body with YAML frontmatter stripped."""
        text = self.file_path.read_text(encoding="utf-8", errors="replace")
        if text.startswith("---\n"):
            close = text.find("\n---\n", 4)
            if close != -1:
                text = text[close + 5 :]
        return text.lstrip("\n")


def _http_get_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=15) as resp:
        return json.load(resp)


def _list_entities(t: str) -> list[dict[str, Any]]:
    payload = _http_get_json(f"{API_ROOT}/api/v1/graph/{t}?include_system=1")
    return payload.get("data") or []


def _file_path_for(asset_ref: str, t: str) -> Path:
    p = Path(asset_ref)
    if t == "skill" and p.is_dir():
        cand = p / "SKILL.md"
        if cand.is_file():
            return cand
    return p


def _build_sample(t: str) -> Sample | None:
    for ent in _list_entities(t):
        if ent.get("system"):
            continue
        ar = ent.get("asset_ref") or ""
        if not ar:
            continue
        fp = _file_path_for(ar, t)
        if not fp.is_file():
            continue
        # vfsPath in the editor URL strips leading /
        vfs_path = ar.lstrip("/")
        url = f"{UI_ROOT}/dock/assets/editor/{t}/{urllib.parse.quote(vfs_path, safe='/')}"
        return Sample(
            type=t,
            id=ent["id"],
            name=ent.get("name") or ent["id"],
            asset_ref=ar,
            url=url,
            file_path=fp,
        )
    return None


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


async def _validate_with_playwright(samples: list[Sample]) -> int:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("playwright not installed. Install with:")
        print("  pip install playwright && playwright install chromium")
        return 2

    failures = 0
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context()
        page = await ctx.new_page()
        for s in samples:
            try:
                await page.goto(s.url, wait_until="networkidle", timeout=20000)
                # Wait for the editor's main textbox to appear
                await page.wait_for_selector(
                    '[data-testid="md-editor-with-side-panel"] [role="textbox"]',
                    timeout=10000,
                )
                await page.wait_for_timeout(500)
                rendered = await page.eval_on_selector(
                    '[data-testid="md-editor-with-side-panel"] [role="textbox"]',
                    "el => el.innerText || el.textContent || ''",
                )
                disk = s.disk_body().strip()
                rendered = (rendered or "").strip()
                if not disk:
                    status = "PASS (file empty, render empty OK)"
                    print(f"{s.type:<16} {s.name:<40} {status}")
                    continue
                if not rendered:
                    failures += 1
                    print(
                        f"{s.type:<16} {s.name:<40} FAIL: editor rendered empty body "
                        f"(disk has {len(disk)} chars sha={_hash(disk)})"
                    )
                    continue
                # Loose match — Milkdown may reflow whitespace
                disk_compact = "".join(disk.split())
                rend_compact = "".join(rendered.split())
                if disk_compact[:200] in rend_compact or rend_compact[:200] in disk_compact:
                    print(
                        f"{s.type:<16} {s.name:<40} PASS (rendered len={len(rendered)} "
                        f"disk len={len(disk)})"
                    )
                else:
                    failures += 1
                    print(
                        f"{s.type:<16} {s.name:<40} FAIL: rendered body does not contain "
                        f"disk body prefix (rend sha={_hash(rendered)} disk sha={_hash(disk)})"
                    )
            except Exception as exc:
                failures += 1
                print(f"{s.type:<16} {s.name:<40} FAIL: {exc!r}")
        await browser.close()
    return failures


def _print_list(samples: list[Sample]) -> None:
    """Emit a JSON list for use with debugMCP-driven validation."""
    out = [
        {
            "type": s.type,
            "id": s.id,
            "name": s.name,
            "asset_ref": s.asset_ref,
            "url": s.url,
            "disk_size": s.file_path.stat().st_size,
            "disk_body_sha16": _hash(s.disk_body()),
        }
        for s in samples
    ]
    print(json.dumps(out, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--list",
        action="store_true",
        help="Print JSON of validation targets (URL + expected body hash) and exit",
    )
    args = parser.parse_args()

    samples: list[Sample] = []
    for t in ASSET_TYPES:
        s = _build_sample(t)
        if s is not None:
            samples.append(s)

    if not samples:
        print("no asset-backed entities with asset_ref found")
        return 0

    if args.list:
        _print_list(samples)
        return 0

    print(f"{'TYPE':<16} {'NAME':<40} STATUS")
    print("-" * 90)
    failures = asyncio.run(_validate_with_playwright(samples))
    print("-" * 90)
    if failures:
        print(f"{failures} type(s) failed")
    else:
        print("all types render cleanly")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
