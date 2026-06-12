"""Validate and lightly inspect World Cup prediction source candidates."""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable

DEFAULT_REGISTRY = Path(__file__).with_name("sources.seed.json")


@dataclass(frozen=True)
class SourceCandidate:
    id: str
    name: str
    kind: str
    url: str
    collection_method: str
    prediction_signal: tuple[str, ...]
    exact_score: bool
    priority: int
    expected_source_volume: int
    notes: str

    @classmethod
    def from_mapping(cls, data: dict[str, object]) -> "SourceCandidate":
        required = ["id", "name", "kind", "url", "collection_method", "prediction_signal"]
        missing = [key for key in required if key not in data]
        if missing:
            raise ValueError(f"source is missing required fields: {', '.join(missing)}")

        return cls(
            id=str(data["id"]),
            name=str(data["name"]),
            kind=str(data["kind"]),
            url=str(data["url"]),
            collection_method=str(data["collection_method"]),
            prediction_signal=tuple(str(value) for value in data["prediction_signal"]),
            exact_score=bool(data.get("exact_score", False)),
            priority=int(data.get("priority", 3)),
            expected_source_volume=int(data.get("expected_source_volume", 1)),
            notes=str(data.get("notes", "")),
        )


class _TitleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._in_title = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.parts.append(data)

    @property
    def title(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()


def load_registry(path: Path = DEFAULT_REGISTRY) -> list[SourceCandidate]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    sources = [SourceCandidate.from_mapping(item) for item in payload.get("sources", [])]
    seen: set[str] = set()
    duplicates: list[str] = []
    for source in sources:
        if source.id in seen:
            duplicates.append(source.id)
        seen.add(source.id)
    if duplicates:
        raise ValueError(f"duplicate source ids: {', '.join(sorted(duplicates))}")
    return sources


def filter_sources(
    sources: Iterable[SourceCandidate],
    *,
    exact_score_only: bool = False,
    collection_method: str | None = None,
) -> list[SourceCandidate]:
    filtered = list(sources)
    if exact_score_only:
        filtered = [source for source in filtered if source.exact_score]
    if collection_method:
        filtered = [source for source in filtered if source.collection_method == collection_method]
    return sorted(filtered, key=lambda source: (source.priority, source.id))


def estimate_source_volume(sources: Iterable[SourceCandidate]) -> int:
    return sum(max(1, source.expected_source_volume) for source in sources)


def fetch_title(url: str, timeout: int = 12) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "flowpad-worldcup-source-discovery/0.1 (+https://github.com/langware-labs/flowpad)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_type = response.headers.get("content-type", "")
        if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
            return f"non-html response: {content_type or 'unknown content-type'}"
        body = response.read(250_000).decode("utf-8", errors="replace")
    parser = _TitleParser()
    parser.feed(body)
    return parser.title or "no title found"


def _cmd_list(args: argparse.Namespace) -> int:
    sources = filter_sources(
        load_registry(Path(args.registry)),
        exact_score_only=args.exact_score_only,
        collection_method=args.collection_method,
    )
    for source in sources:
        signals = ",".join(source.prediction_signal)
        print(f"{source.id}\t{source.collection_method}\texact={source.exact_score}\tsignals={signals}\t{source.url}")
    print(f"\nlisted={len(sources)} estimated_source_volume={estimate_source_volume(sources)}")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    sources = load_registry(Path(args.registry))
    exact = [source for source in sources if source.exact_score]
    print(f"sources={len(sources)} exact_score_sources={len(exact)} estimated_source_volume={estimate_source_volume(sources)}")
    return 0


def _cmd_probe(args: argparse.Namespace) -> int:
    sources = filter_sources(
        load_registry(Path(args.registry)),
        exact_score_only=args.exact_score_only,
        collection_method=args.collection_method,
    )[: args.limit]

    for source in sources:
        if source.collection_method in {"x_api", "reddit_api", "youtube_api", "manual_export"}:
            print(f"{source.id}\tskipped\t{source.collection_method} required\t{source.url}")
            continue
        try:
            title = fetch_title(source.url, timeout=args.timeout)
            print(f"{source.id}\tok\t{title}\t{source.url}")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"{source.id}\terror\t{exc}\t{source.url}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="World Cup prediction source registry tools")
    parser.add_argument("--registry", default=str(DEFAULT_REGISTRY), help="source registry JSON file")
    subparsers = parser.add_subparsers(required=True)

    list_cmd = subparsers.add_parser("list", help="list source candidates")
    list_cmd.add_argument("--exact-score-only", action="store_true")
    list_cmd.add_argument("--collection-method")
    list_cmd.set_defaults(func=_cmd_list)

    validate = subparsers.add_parser("validate", help="validate the registry")
    validate.set_defaults(func=_cmd_validate)

    probe = subparsers.add_parser("probe", help="fetch titles for a small set of HTML/API-free sources")
    probe.add_argument("--limit", type=int, default=10)
    probe.add_argument("--timeout", type=int, default=12)
    probe.add_argument("--exact-score-only", action="store_true")
    probe.add_argument("--collection-method")
    probe.set_defaults(func=_cmd_probe)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
