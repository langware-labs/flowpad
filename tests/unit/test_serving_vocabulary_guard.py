"""Nothing we ship teaches a serving path — or an answering path — that no longer exists.

Everything a machine serves is a ``ServiceEndpoint`` (``docs/snippets/service-endpoints.md``).
The paths it replaced — a per-process port lookup, a probe on the process, the
``micro_app`` view route — were deleted, not deprecated. A skill, agent or doc that
still describes one sends an agent (or a person) to a route that 404s, so the words
are refused wherever we teach: the shipped skills and agents, the web-app template,
and ``docs/`` outside ``docs/historical``.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

TAUGHT = [
    *(REPO / "flow_sdk" / "system_projects").rglob("*.md"),
    *(REPO / "flow_sdk" / "system_projects").rglob("*.js"),
    *(p for p in (REPO / "docs").rglob("*.md") if "historical" not in p.relative_to(REPO / "docs").parts),
    REPO / "README.md",
]

GONE = re.compile(
    r"get-host|probe-webapp|getWebAppHostUrl|useProcessWebApp|view_external_domain"
    r"|micro_app/[^/\s`]+/view\b|\{kind: webapp"
)


def test_no_shipped_skill_agent_or_doc_teaches_a_deleted_serving_path():
    found = [
        f"{path.relative_to(REPO)}:{number}: {line.strip()[:120]}"
        for path in TAUGHT
        if path.is_file() and "node_modules" not in path.parts
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1)
        if GONE.search(line)
    ]
    assert not found, "these still teach a serving path that was deleted — use ServiceEndpoint:\n" + "\n".join(found)


#: An agent answers its channels from its placement's serve loop (``builtin/agent_serve``). The bus
#: runner that answered by reacting to the projection's tags was deleted with its entry points.
GONE_ANSWERING = re.compile(r"handle_inbound|stream_inbox/agent_runner|stream_inbox\.agent_runner|subscribe_agent_mail")


def test_no_shipped_skill_agent_or_doc_teaches_the_deleted_bus_runner():
    found = [
        f"{path.relative_to(REPO)}:{number}: {line.strip()[:120]}"
        for path in TAUGHT
        if path.is_file() and "node_modules" not in path.parts
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1)
        if GONE_ANSWERING.search(line)
    ]
    assert not found, "these still teach the deleted bus runner — an agent answers from its serve loop:\n" + "\n".join(found)
