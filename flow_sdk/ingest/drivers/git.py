"""Git — a repository as a data source.

The folder driver's payload was already on disk; this one's arrives through a
transport that has to be asked. That is the point of it: Access becomes real
work while credentials stay out of scope entirely, because a local repository
needs none.

**It diffs; it never walks.** The defining invariant. Every changed path comes
from `git diff --name-status`, including the first run — which diffs against
git's empty tree rather than listing the working directory. A git driver that
enumerates a directory is a folder source wearing a git hat, and the difference
matters: the diff is what makes deletions and renames exact instead of inferred.

**Renames come from the transport.** `--find-renames` hands over old/new pairs
directly. The folder driver had to infer them from inodes, which an
atomic-saving editor defeats; git simply knows. Same principle as Drive's
`fileId` — a better transport buys fidelity, and nothing above the driver changes.

**The cursor is one sha, and that makes the backstop exact.** Every other source
recovers a missed event by enumerating and diffing. Here recovery is
`git diff <last-sha>..HEAD` — complete, and cheap enough that a lost webhook
costs nothing.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from flow_sdk.ingest.driver import FetchResult, SetupVerdict, SegmentCursorView, SegmentRef
from flow_sdk.ingest.health import SourceError
from flow_sdk.utils.git import _run_git, git_current_branch, git_remote_url

#: Git's empty tree. Diffing against it yields "everything currently present",
#: so a first run needs no separate listing path — one code path, and the
#: never-walk invariant holds even on the very first sync.
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

#: Rename similarity floor. Git's own default; named here because moving it
#: silently changes which edits read as renames rather than delete+create.
RENAME_SIMILARITY = "50%"


def _repo_of(source) -> Path:
    raw = (source.config or {}).get("repo") or ""
    if not raw:
        raise SourceError.config("no_repo", "config.repo is not set")
    return Path(raw).expanduser()


def _git(repo: Path, *args: str) -> str:
    # No timeout argument: the house default applies. Widening it here would
    # be a new wait budget, and a git command that needs longer than the
    # default is a slow path to fix rather than to wait out.
    result = _run_git(["git", *args], str(repo))
    if result.returncode != 0:
        raise SourceError.transient("git_failed", (result.stderr or "").strip()[:300])
    return result.stdout


def _head(repo: Path) -> str:
    return _git(repo, "rev-parse", "HEAD").strip()


class GitDriver:
    provider = "git"
    kind = "datasource.vcs.git"
    #: Declared for protocol symmetry only. This driver never produces an
    #: IngestItem — its payload lands as files, not as records.
    record_kind = ""
    #: A tracked file is not ours to rewrite. Identity comes from `origin_id`,
    #: so the working tree stays byte-clean and `git status` after an index
    #: pass shows nothing.
    stamps_identity = False

    def source_root(self, source):
        """The repository root — refs are repo-relative, and must stay so."""
        raw = (source.config or {}).get("repo") or ""
        return Path(raw).expanduser().resolve() if raw else None

    def origin_id_for(self, source, ref: str) -> str:
        """``GitOrigin.key()`` — the repo-relative position of this asset.

        Deliberately the documented dedup handle rather than something new:
        `uuid5(canonical-remote-key : rel_path)`, branch-independent, identical
        on every machine. That is what lets a checkout made here and a clone
        made elsewhere reconcile to one entity.

        Computable for a path that no longer EXISTS, which the folder driver's
        inode handle is not — so a deleted or renamed-from path still resolves
        to its row.
        """
        from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415

        repo = _repo_of(source)
        rel = Path(ref).resolve().relative_to(repo.resolve()).as_posix()
        origin = GitOrigin.from_url(git_remote_url(str(repo)), rel_path=rel)
        if origin is None:
            # No parseable remote — fall through to the generic path handle
            # rather than inventing a second git-shaped key.
            return ""
        return str(origin.key())

    def segments(self, source) -> list[SegmentRef]:
        """One scope per branch.

        Not per subdirectory: a directory is a mutable grouping, and a path that
        moves between groupings is the duplicate-on-move trap. A branch is the
        unit a sha actually means something against.
        """
        raw = (source.config or {}).get("repo") or ""
        if not raw:
            return []
        branch = (source.config or {}).get("branch") or "HEAD"
        return [SegmentRef(key=str(branch), label=str(raw))]

    async def verify(self, source) -> SetupVerdict:
        raw = (source.config or {}).get("repo") or ""
        if not raw:
            return SetupVerdict.waiting("Set the repository to track.")
        repo = Path(raw).expanduser()
        if not (repo / ".git").exists():
            return SetupVerdict.waiting(f"{repo} is not a git repository.")
        try:
            _head(repo)
        except SourceError:
            return SetupVerdict.waiting(f"{repo} has no commits yet.")
        return SetupVerdict.ok()

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        repo = _repo_of(source)
        if not (repo / ".git").exists():
            # Needs a person, not a retry.
            raise SourceError.config("not_a_repo", f"{repo} is not a git repository")

        head = _head(repo)
        previous = (cursor.state or {}).get("sha") or EMPTY_TREE
        if previous == head:
            return FetchResult(next_state={"sha": head}, high_water=head, unchanged=True)

        refs, tombstones, renames = self._diff(repo, previous, head)
        return FetchResult(
            refs=refs,
            tombstones=tombstones,
            renames=renames,
            next_state={"sha": head},
            high_water=head,
            unchanged=not (refs or tombstones),
        )

    def _diff(self, repo: Path, before: str, after: str):
        """`(refs, tombstones, renames)` between two commits.

        A rename is reported as its NEW path plus an old→new pair, never as a
        deletion beside a creation. Emitting the pair is what lets identity move
        with the file instead of being destroyed and re-minted.
        """
        raw = _git(
            repo,
            "diff",
            "--name-status",
            f"--find-renames={RENAME_SIMILARITY}",
            "-z",
            f"{before}..{after}",
        )
        refs: list[str] = []
        tombstones: list[str] = []
        renames: dict[str, str] = {}

        # `-z` because a path may contain anything, newlines included. Records
        # are NUL-separated and a rename spends THREE of them (status, old,
        # new), so this consumes an ITERATOR — `next()` takes the extra field
        # only when the status says there is one, which is what keeps the two
        # record shapes from needing index arithmetic to tell apart.
        fields = iter(part for part in raw.split("\0") if part)
        for status in fields:
            code = status[:1]
            if code == "R":
                old_path, new_path = next(fields, ""), next(fields, "")
                if not new_path:
                    break
                refs.append(str(repo / new_path))
                renames[str(repo / new_path)] = str(repo / old_path)
                continue
            path = next(fields, "")
            if not path:
                break
            if code == "D":
                tombstones.append(str(repo / path))
            else:  # A, M, C, T — this path now has content worth indexing
                refs.append(str(repo / path))

        return refs, tombstones, renames
