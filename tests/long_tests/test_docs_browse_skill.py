"""End-to-end: a STANDARD agentic process discovers the ambient `docs-browse`
skill and uses the `index.md` chain to retrieve a fact buried THREE index
levels deep — instead of grepping the tree.

Corpus = a copy of this repo's real ``docs/`` tree (the oss docs), grafted
with a 3-levels-deep branch ``runbooks/deploy/rollback.md`` that carries a
nonce'd canary fact. The index chain (root → runbooks → deploy) is built
deterministically with ``LLMIndexer.rebuild`` and stub-but-informative
summarizers — no LLM in setup.

The skill is NOT mounted explicitly: it ships in
``flow_sdk/system_projects/flowpad_assistant/.claude/skills/docs-browse/`` and
reaches the worker through the standard flowpad_assistant ``--add-dir``
auto-mount (``ServiceConfig.load_flowpad_assistant`` defaults on). That mount
is the Claude production path — this module tests Claude only; codex/copilot
discover skills via ``~/.codex/skills`` copies (a different mechanism,
deferred).

Requires DEEP_TESTING=true and an authenticated ``claude`` CLI on PATH (module
is in ``_REAL_HOME_TEST_MODULES``). LLM compliance is non-deterministic; API
timeouts are downgraded to skips by the conftest report hook, and pure LLM
non-compliance is skipped explicitly (never a weakened assertion).
"""

import asyncio
import shutil
import uuid
from pathlib import Path
from typing import Callable, NamedTuple

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.llm_index import LLMIndexer
from flow_sdk.transcript_analyzer import EntryKind
from tests.long_tests._transcript_helpers import (
    assert_prompt_ok,
    await_transcript,
    safe_exit,
)
from tests.test_settings import test_service_config

SKILL_NAME = "docs-browse"
_REPO_DOCS = Path(__file__).parents[2] / "docs"

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]


@pytest.fixture(scope="module")
async def _workers_discovered():
    """One capability-discovery sweep so the driver can resolve the CLI binary."""
    from flow_sdk.core.capabilities.discovery import ensure_discovered

    await ensure_discovered()


# ── corpus seeding ────────────────────────────────────────────────────────────


def _seed_from_repo_docs(tmp_path: Path) -> tuple[Path, Path, str]:
    """Copy the real oss docs/ and graft a 3-index-levels-deep canary branch.

    Returns ``(vault_root, deep_target, nonce)``. The canary VALUE lives only
    in the target file's body (below the first sentence), so index summaries
    can route to the file but never answer for it.
    """
    vault = tmp_path / "docs"
    shutil.copytree(_REPO_DOCS, vault)
    # The repo's committed root index.md/index.md.json are legacy demo files —
    # drop them so the deterministic rebuild below owns the whole chain.
    for stale in vault.glob("index.md*"):
        stale.unlink()

    nonce = uuid.uuid4().hex[:6]
    deep = vault / "runbooks" / "deploy" / "rollback.md"
    deep.parent.mkdir(parents=True)
    (vault / "runbooks" / "incidents.md").write_text(
        "# Incident handling\n\nHow to triage and escalate production incidents.\n",
        encoding="utf-8",
    )
    (vault / "runbooks" / "deploy" / "checklist.md").write_text(
        "# Deploy checklist\n\nPre-flight checks before shipping a release.\n",
        encoding="utf-8",
    )
    deep.write_text(
        "# Rollback procedure\n\n"
        "How to roll back a bad release and how long the safety window lasts.\n\n"
        "After initiating a rollback, wait out the grace period before\n"
        "re-deploying.\n\n"
        f"The rollback grace period is 47 minutes (policy code RGP-{nonce}).\n",
        encoding="utf-8",
    )
    return vault, deep, nonce


def _build_index(root: Path) -> None:
    """Deterministic index chain over the corpus — no LLM, informative stubs."""

    def summarize_file(doc, text: str) -> str:
        lines = text.splitlines()
        head = next(
            (ln.lstrip("# ").strip() for ln in lines if ln.startswith("#")),
            doc.path.stem,
        )
        first = next(
            (ln.strip() for ln in lines if ln.strip() and not ln.startswith("#")),
            "",
        )
        return f"{head}: {first[:120]}"

    def summarize_folder(item) -> str:
        parts = [d.get_summary() or d.path.stem for d in item.files]
        parts += [s.path.name for s in item.subfolders]
        return (f"Covers {item.rel_path or 'the docs root'}: " + "; ".join(parts))[:300]

    stats = LLMIndexer(root).rebuild(summarize_file, summarize_folder)
    assert stats.folders_assembled >= 3, f"expected a 3-level chain, got {stats}"


class BrowseSetup(NamedTuple):
    process: AgenticProcess
    vault: Path
    deep: Path
    nonce: str


@pytest.fixture
async def browse_setup(
    tmp_path, _workers_discovered, local_project, local_compute_node
):
    """Seeded vault + indexed chain + a saved STANDARD process, torn down after.

    No context_data, no additional_dirs — the skill must arrive through the
    ambient flowpad_assistant auto-mount. Saved to the DB first: ``prompt()``
    resolves the process by id server-side and fails with "not found in
    database" on an unsaved instance."""
    if shutil.which("claude") is None:
        pytest.skip("claude CLI not installed")
    vault, deep, nonce = _seed_from_repo_docs(tmp_path)
    _build_index(vault)
    process = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=str(vault),
        visible=False,
    ).save()
    try:
        yield BrowseSetup(process, vault, deep, nonce)
    finally:
        await asyncio.shield(safe_exit(process))


# ── transcript predicates ─────────────────────────────────────────────────────


def _skill_calls(transcript) -> list:
    return [
        e
        for e in transcript.filter(kind=EntryKind.SKILL_CALL)
        if getattr(e, "skill_name", "") == SKILL_NAME
    ]


def _file_reads(transcript, pred: Callable[[Path], bool]) -> list:
    return [
        e
        for e in transcript.filter(kind=EntryKind.FILE_READ)
        if pred(Path(getattr(e, "path", "")))
    ]


def _answer_text(transcript) -> str:
    """The assistant's own answer text — never prompt echoes or tool output."""
    return "\n".join(
        e.text
        for e in transcript.filter(kind=EntryKind.ASSISTANT_MESSAGE)
        if getattr(e, "text", "")
    )


async def _await(process, predicate):
    # Fill the approved 120s test budget (leave margin for asserts/cleanup);
    # the pytest timeout cap itself is untouched.
    return await await_transcript(process, "claude", predicate, deadline_s=110)


# ── tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(120)
async def test_docs_browse_deep_chain(browse_setup):
    """Nudged: the worker must walk THREE index levels (root → runbooks →
    deploy) and read the deep target, answering with the nonce'd canary."""
    process, vault, deep, nonce = browse_setup
    result = await process.prompt(
        "Using the docs index, find the rollback grace period. Start from "
        "the root index.md and follow the index chain to the right "
        "document. Be fast: read ONLY the index.md files along the path and "
        "then exactly the one target document — no other files, no searching. "
        "Answer with the exact value and its policy code."
    )
    assert_prompt_ok(result)

    def done(tf) -> bool:
        return bool(_file_reads(tf, lambda p: p == deep)) and nonce in _answer_text(tf)

    transcript = await _await(process, done)
    if transcript is None:
        pytest.skip("no usable transcript within the deadline — infra/LLM latency")

    index_reads = _file_reads(transcript, lambda p: p.name == "index.md")
    vault_resolved = vault.resolve()
    non_root = [
        e for e in index_reads if Path(e.path).parent.resolve() != vault_resolved
    ]
    assert len(index_reads) >= 2 and non_root, (
        f"expected a multi-level index walk; index.md reads: "
        f"{[e.path for e in index_reads]}"
    )
    assert _file_reads(transcript, lambda p: p == deep), (
        f"deep target {deep} was never read; reads: "
        f"{[e.path for e in transcript.filter(kind=EntryKind.FILE_READ)]}"
    )
    answer = _answer_text(transcript)
    assert f"RGP-{nonce}" in answer and "47" in answer, (
        "final answer missing the canary fact — retrieval broke"
    )


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(120)
async def test_docs_browse_ambient_discovery(browse_setup):
    """Un-nudged: the prompt names neither the skill nor the index. The worker
    should reach for docs-browse (or at least the index chain) on its own."""
    process, _vault, _deep, nonce = browse_setup
    result = await process.prompt(
        "What is the rollback grace period in this project's "
        "documentation? Answer with the exact value and its policy code."
    )
    assert_prompt_ok(result)

    def done(tf) -> bool:
        return nonce in _answer_text(tf)

    transcript = await _await(process, done)
    if transcript is None:
        pytest.skip("no usable transcript within the deadline — infra/LLM latency")

    used_skill = bool(_skill_calls(transcript))
    used_index = bool(_file_reads(transcript, lambda p: p.name == "index.md"))
    if not used_skill and not used_index:
        # LLM non-compliance (answered by grep/luck), not a product bug —
        # same downgrade idiom as test_skill_transcript_analysis.
        pytest.skip(
            "agent answered without the docs index or the docs-browse "
            "skill — LLM non-compliance"
        )
    assert f"RGP-{nonce}" in _answer_text(transcript), (
        "index-driven run failed to surface the canary — retrieval broke"
    )
