"""Build the Flow SDK page from the docs shelf: every python card IS a docs fence.

The page (``index.html``, published as an Artifact) and its Markdown twin (``flow-sdk.md``) quote
code. A quote nobody runs drifts the moment a signature moves, and the page did: cards glued two
fences together, showed a driver that did not ship, and ran nothing a test ran. So a card holds no
code of its own. ``cards.json`` names, per card id, the fence it shows — ``{doc, heading, nth}`` of
``docs/snippets/<doc>`` (the same address ``tests/utils/snippets.fence_under`` resolves, and the
fence's own pinned test runs it verbatim), or ``{opening: <channel>}`` for the hero's four tabs
(``workflows.md`` §6 with that channel's line, ``opening_programs``) — and ``md`` lists the python
blocks of ``flow-sdk.md`` that show the same code.

    uv run python docs/sdk-site/build.py           # rewrite index.html and flow-sdk.md in place
    uv run python docs/sdk-site/build.py --check   # exit 1 when either is out of date

``tests/unit/test_sdk_site_cards.py`` is the gate: every python card has a row, the files equal a
fresh build, nothing is labelled illustrative, and each card passes the snippet viewer's check.
"""

from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from pygments import highlight  # noqa: E402
from pygments.formatters import HtmlFormatter  # noqa: E402
from pygments.lexers import PythonLexer  # noqa: E402

from tests.utils.snippets import doc, fence_under, opening_programs  # noqa: E402

PAGE = HERE / "index.html"
GUIDE = HERE / "flow-sdk.md"
CARDS = HERE / "cards.json"

PROOF = '<span class="proof">✓ runs in CI</span>'
_EXCERPT = re.compile(r'<span class="excerpt">[^<]*</span>')
_MD_PY = re.compile(r"```python\n(.*?)\n```", re.DOTALL)
_ROW = re.compile(r'<span class="row">(<a class="pin"[^>]*>[^<]*</a>|<span class="pin pin-empty" aria-hidden="true"></span>)<span class="ln"')
_EMPTY_PIN = '<span class="pin pin-empty" aria-hidden="true"></span>'


def cards() -> dict[str, dict]:
    return json.loads(CARDS.read_text())


def program(entry: dict) -> str:
    """The code a card shows: its fence, verbatim."""
    if "opening" in entry:
        return opening_programs()[entry["opening"]]
    return fence_under(doc(entry["doc"]), entry["heading"], nth=entry["nth"])


def _hl(source: str) -> str:
    """Pygments' spans for *source*, ending where *source* ends (the formatter adds a newline)."""
    out = highlight(source, PythonLexer(stripnl=False, ensurenl=False), HtmlFormatter(nowrap=True))
    return out[:-1] if out.endswith("\n") and not source.endswith("\n") else out


def split_imports(source: str, *, first_group: bool = False) -> tuple[str, str, int]:
    """``(imports, rest, count)``: the leading import block — with the blank lines after it, so the
    code starts where it did — and how many import statements it holds.

    ``first_group`` stops at the first blank line: the stdlib group a card folds away, leaving the
    ``flow_sdk`` imports on screen — they say where each name comes from."""
    lines = source.split("\n")
    count, i, open_paren = 0, 0, False
    while i < len(lines):
        line = lines[i]
        if open_paren:
            open_paren = ")" not in line
        elif line.startswith(("import ", "from ")):
            count += 1
            open_paren = "(" in line and ")" not in line
        elif line.strip() or count == 0:
            break
        elif first_group:
            while i < len(lines) and not lines[i].strip():
                i += 1
            break
        i += 1
    if count == 0:
        return "", source, 0
    return "\n".join(lines[:i]) + "\n", "\n".join(lines[i:]), count


def card_html(source: str) -> str:
    """A card's ``<code>`` contents: imports folded behind a note (the Copy button keeps them)."""
    imports, rest, n = split_imports(source, first_group=True)
    if not n:
        return _hl(source)
    note = f'<button type="button" class="imp-note" aria-expanded="false">⋯ {n} import{"s" if n > 1 else ""}</button>'
    return f'{note}<span class="imp">{_hl(imports)}</span>{_hl(rest)}'


def _swap_marks(line_html: str) -> str:
    """Highlight the two words a channel tab changes: the address and the provider."""
    count = 0

    def mark(m: re.Match) -> str:
        nonlocal count
        count += 1
        return f'&quot;<mark class="swap">{m.group(1)}</mark>&quot;' if count <= 2 else m.group(0)

    return re.sub(r"&quot;([^&<]*)&quot;", mark, line_html)


def hero_html(source: str, old: str) -> str:
    """The annotated hero: one row per line of the WHOLE program (imports included — a copied tab
    must run), keeping each code line's pin from the page as it was."""
    pins = _ROW.findall(old)
    imports, rest, _ = split_imports(source)
    body = rest.split("\n")
    if len(pins) == len(body) + len(imports.split("\n")) - 1:
        pins = pins[len(imports.split("\n")) - 1 :]  # built before: drop the import rows' empty pins
    if len(pins) != len(body):
        raise ValueError(f"the hero has {len(pins)} pinned rows but the program has {len(body)} code lines")
    all_pins = [_EMPTY_PIN] * (len(imports.split("\n")) - 1) + pins
    rows = []
    for n, (pin, line) in enumerate(zip(all_pins, _hl(source).split("\n")), start=1):
        if "StreamInbox" in line:
            line = _swap_marks(line)
        pin = re.sub(r'aria-label="Line \d+:', f'aria-label="Line {n}:', pin)
        rows.append(f'<span class="row">{pin}<span class="ln" aria-hidden="true">{n}</span><span class="lc">{line or " "}</span></span>')
    return "".join(rows)


def _code_span(page: str, card_id: str) -> tuple[int, int]:
    """Where the card's ``<code>`` contents start and end in *page*."""
    at = page.find(f'id="{card_id}"')
    if at < 0:
        raise LookupError(f"no card {card_id!r} on the page")
    start = page.index("<code>", at) + len("<code>")
    return start, page.index("</code></pre>", start)


def build_page(page: str, table: dict[str, dict]) -> str:
    for card_id, entry in table.items():
        source = program(entry)
        start, end = _code_span(page, card_id)
        inner = hero_html(source, page[start:end]) if "opening" in entry else card_html(source)
        page = page[:start] + inner + page[end:]
        caption_end = page.find("</figure>", start)
        caption = page[start:caption_end]
        if _EXCERPT.search(caption):
            page = page[:start] + _EXCERPT.sub(PROOF, caption) + page[caption_end:]
    return page


def build_guide(guide: str, table: dict[str, dict]) -> str:
    blocks = list(_MD_PY.finditer(guide))
    replacement: dict[int, str] = {}
    for entry in table.values():
        for index in entry.get("md", []):
            replacement[index] = program(entry)
    out, last = [], 0
    for index, block in enumerate(blocks):
        out.append(guide[last : block.start(1)])
        out.append(replacement.get(index, block.group(1)))
        last = block.end(1)
    out.append(guide[last:])
    return re.sub(r"^# illustrative[^\n]*\n", "", "".join(out), flags=re.MULTILINE)


_EMBEDDED_MD = re.compile(r'(<script type="text/markdown" id="(md-[a-z]+)">)(.*?)(</script>)', re.DOTALL)


def embed_guide(page: str, guide: str) -> str:
    """The page carries the guide for its "Copy as Markdown" buttons: ``md-full`` is the whole of
    ``flow-sdk.md``, each other ``md-<chapter>`` the chapter its first line names — escaped, as the
    browser reads a script's text back."""

    def chapter(heading: str) -> str:
        start = guide.index(heading + "\n")
        end = guide.find("\n## ", start + 1)
        return guide[start : end if end > 0 else len(guide)]

    def replace(m: re.Match) -> str:
        opening, sid, body, closing = m.groups()
        if sid == "md-full":
            return opening + html.escape(guide) + closing
        text = html.unescape(body)
        lead, trail = text[: len(text) - len(text.lstrip())], text[len(text.rstrip()) :]
        return opening + lead + html.escape(chapter(text.strip().split("\n", 1)[0]).strip()) + trail + closing

    return _EMBEDDED_MD.sub(replace, page)


def render() -> dict[Path, str]:
    """The files as a fresh build writes them."""
    table = cards()
    guide = build_guide(GUIDE.read_text(), table)
    return {PAGE: embed_guide(build_page(PAGE.read_text(), table), guide), GUIDE: guide}


def main(argv: list[str]) -> int:
    fresh = render()
    stale = [path for path, text in fresh.items() if path.read_text() != text]
    if "--check" in argv:
        for path in stale:
            print(f"out of date: {path.relative_to(REPO)} — run: uv run python docs/sdk-site/build.py")
        return 1 if stale else 0
    for path in stale:
        path.write_text(fresh[path])
        print(f"wrote {path.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
