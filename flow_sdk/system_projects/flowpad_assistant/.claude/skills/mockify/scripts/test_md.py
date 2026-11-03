"""`mockify test`: write an approved test mock as a manual-regression scenario (.md).

    $FLOWPAD_PYTHON -I test_md.py <mock-row.json> <repo root> [--replace]

Reads the mock row (a value, a row with `input`, or `DM ds-rows` output) -- one that passed validate_mock.py,
which checks a test mock is the current UI -- and writes `<repo>/<test_md>` in the format of
ui/tests/manual_regression/*.md: `test N:` blocks of bullets.
  test 1      the main path (steps with no branch_of)
  test 2..N   one per branch: the path to the step it branches from, then the branch
Per step on a path: `url` -> `- navigate to {APP_URL}<url>`; each `expect` -> `- validate …`; the control
that leads to the next step -> `- click "<label>" — <does>`; a branch reached with no control -> `- when <when>`.
An existing file needs --replace, which keeps its id. Prints {ok, written, tests, steps_without_expect}.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))   # -I leaves the script's folder off the path
from build_mock import load_row  # noqa: E402
from mock_project import fail, out  # noqa: E402


def paths(journey: list[dict]) -> list[tuple[str, list[dict]]]:
    """(title, steps) per test: the main path first, then one per branch."""
    by_id = {s["id"]: s for s in journey}
    main = [s for s in journey if not s.get("branch_of")]

    def path_to(step: dict) -> list[dict]:
        parent = step.get("branch_of")
        return path_to(by_id[parent]) + [step] if parent else main[: main.index(step) + 1]

    tests = [("main path", main)]
    for step in journey:
        if step.get("branch_of"):
            steps = path_to(step) + ([by_id[step["next"]]] if step.get("next") in by_id else [])
            tests.append((step.get("when") or step["title"], steps))
    return tests


def bullets(steps: list[dict]) -> list[str]:
    out: list[str] = []
    for i, step in enumerate(steps):
        if step.get("url"):
            out.append(f"- navigate to {{APP_URL}}{step['url']}")
        out += [f"- validate {e}" for e in step.get("expect") or []]
        if i + 1 == len(steps):
            break
        nxt = steps[i + 1]
        control = next((c for c in step.get("controls") or [] if c.get("next") == nxt["id"]), None)
        if control:
            out.append(f'- click "{control["label"]}" — {control["does"]}')
        elif nxt.get("branch_of") == step["id"] and nxt.get("when"):
            out.append(f"- when {nxt['when']}")
        else:
            out.append(f"- go on to {nxt['title']}")
    return out


def main() -> None:
    replace = "--replace" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--replace"]
    if len(args) != 2:
        fail("usage: test_md.py <mock-row.json> <repo root> [--replace]")
    mock = load_row(args[0])
    repo = pathlib.Path(args[1]).resolve()
    if not mock.get("test_md"):
        fail("the mock has no test_md: it is not a test mock")
    target = (repo / mock["test_md"]).resolve()
    if repo not in target.parents or target.suffix != ".md":
        fail(f"test_md must be a .md inside the repo: {mock['test_md']}")
    exists = target.exists()
    if exists and not replace:
        fail(f"{mock['test_md']} exists; pass --replace to overwrite it")

    journey = mock.get("journey") or []
    tests = paths(journey)
    lines: list[str] = []
    for n, (title, steps) in enumerate(tests, 1):
        lines.append(f"test {n}: {mock['title']} — {title}")
        if mock.get("setup"):
            lines.append(f"- setup: {mock['setup']}")
        lines += bullets(steps) + [""]

    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.assets.document import write_document
    target.parent.mkdir(parents=True, exist_ok=True)
    # an existing file keeps its id: write_document never replaces an identity
    write_document(target, body="\n".join(lines), fields=None if exists else {"id": mint_uuid()})
    out(written=str(target), tests=len(tests), steps_without_expect=[s["id"] for s in journey if not s.get("expect")])


if __name__ == "__main__":
    main()
