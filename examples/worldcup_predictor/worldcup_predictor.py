"""Weighted score prediction prototype for World Cup matches.

The core idea is intentionally simple:

1. Keep every source's exact-score predictions in a JSONL ledger.
2. Score resolved predictions against final results.
3. Build a reliability index globally and per source/team.
4. Weight current predictions by that reliability and aggregate the expected score.

The module is dependency-free so it can run as a standalone research tool before
being promoted into a Flowpad feature.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

Outcome = str
Scoreline = tuple[int, int]


def _outcome(home_goals: int, away_goals: int) -> Outcome:
    if home_goals > away_goals:
        return "H"
    if home_goals < away_goals:
        return "A"
    return "D"


def _bounded_similarity(predicted: int, actual: int, max_error: int = 4) -> float:
    return max(0.0, 1.0 - (abs(predicted - actual) / max_error))


@dataclass(frozen=True)
class PredictionRecord:
    """One source's prediction for one fixture."""

    fixture_id: str
    source_id: str
    home_team: str
    away_team: str
    predicted_home_goals: int
    predicted_away_goals: int
    actual_home_goals: int | None = None
    actual_away_goals: int | None = None
    predicted_at: str | None = None
    source_url: str | None = None
    raw_text: str | None = None

    @property
    def is_resolved(self) -> bool:
        return self.actual_home_goals is not None and self.actual_away_goals is not None

    @property
    def predicted_scoreline(self) -> Scoreline:
        return (self.predicted_home_goals, self.predicted_away_goals)

    @property
    def actual_scoreline(self) -> Scoreline | None:
        if not self.is_resolved:
            return None
        return (self.actual_home_goals or 0, self.actual_away_goals or 0)

    @classmethod
    def from_mapping(cls, data: dict[str, object]) -> "PredictionRecord":
        required = [
            "fixture_id",
            "source_id",
            "home_team",
            "away_team",
            "predicted_home_goals",
            "predicted_away_goals",
        ]
        missing = [key for key in required if key not in data]
        if missing:
            raise ValueError(f"prediction record is missing required fields: {', '.join(missing)}")

        return cls(
            fixture_id=str(data["fixture_id"]),
            source_id=str(data["source_id"]),
            home_team=str(data["home_team"]),
            away_team=str(data["away_team"]),
            predicted_home_goals=int(data["predicted_home_goals"]),
            predicted_away_goals=int(data["predicted_away_goals"]),
            actual_home_goals=_optional_int(data.get("actual_home_goals")),
            actual_away_goals=_optional_int(data.get("actual_away_goals")),
            predicted_at=_optional_str(data.get("predicted_at")),
            source_url=_optional_str(data.get("source_url")),
            raw_text=_optional_str(data.get("raw_text")),
        )

    def to_mapping(self) -> dict[str, object]:
        data: dict[str, object] = {
            "fixture_id": self.fixture_id,
            "source_id": self.source_id,
            "home_team": self.home_team,
            "away_team": self.away_team,
            "predicted_home_goals": self.predicted_home_goals,
            "predicted_away_goals": self.predicted_away_goals,
        }
        if self.actual_home_goals is not None:
            data["actual_home_goals"] = self.actual_home_goals
        if self.actual_away_goals is not None:
            data["actual_away_goals"] = self.actual_away_goals
        if self.predicted_at:
            data["predicted_at"] = self.predicted_at
        if self.source_url:
            data["source_url"] = self.source_url
        if self.raw_text:
            data["raw_text"] = self.raw_text
        return data


@dataclass(frozen=True)
class SourceStats:
    """Bayesian-smoothed accuracy for a source or source/team pair."""

    source_id: str
    score: float
    sample_count: int
    raw_average: float

    @property
    def confidence(self) -> float:
        if self.sample_count <= 0:
            return 0.0
        return min(1.0, math.log1p(self.sample_count) / math.log1p(30))

    @property
    def weight_multiplier(self) -> float:
        return max(0.05, self.score) * (0.35 + 0.65 * self.confidence)


@dataclass(frozen=True)
class Forecast:
    fixture_id: str
    home_team: str
    away_team: str
    predicted_home_goals: float
    predicted_away_goals: float
    source_count: int
    total_weight: float
    home_win_probability: float
    draw_probability: float
    away_win_probability: float
    top_scorelines: list[tuple[int, int, float]]

    def to_mapping(self) -> dict[str, object]:
        return {
            "fixture_id": self.fixture_id,
            "home_team": self.home_team,
            "away_team": self.away_team,
            "predicted_home_goals": round(self.predicted_home_goals, 3),
            "predicted_away_goals": round(self.predicted_away_goals, 3),
            "source_count": self.source_count,
            "total_weight": round(self.total_weight, 3),
            "home_win_probability": round(self.home_win_probability, 4),
            "draw_probability": round(self.draw_probability, 4),
            "away_win_probability": round(self.away_win_probability, 4),
            "top_scorelines": [
                {"home_goals": home, "away_goals": away, "probability": round(probability, 4)}
                for home, away, probability in self.top_scorelines
            ],
        }


class ReliabilityIndex:
    """Tracks source accuracy globally and by team specialization."""

    def __init__(
        self,
        source_stats: dict[str, SourceStats],
        team_stats: dict[tuple[str, str], SourceStats],
        prior_score: float = 0.45,
    ) -> None:
        self.source_stats = source_stats
        self.team_stats = team_stats
        self.prior_score = prior_score

    @classmethod
    def from_records(
        cls,
        records: Iterable[PredictionRecord],
        prior_score: float = 0.45,
        prior_strength: int = 6,
    ) -> "ReliabilityIndex":
        source_scores: dict[str, list[float]] = defaultdict(list)
        team_scores: dict[tuple[str, str], list[float]] = defaultdict(list)

        for record in records:
            if not record.is_resolved:
                continue
            score = score_prediction(record)
            source_scores[record.source_id].append(score)
            team_scores[(record.source_id, normalize_team(record.home_team))].append(score)
            team_scores[(record.source_id, normalize_team(record.away_team))].append(score)

        source_stats = {
            source_id: _stats(source_id, scores, prior_score, prior_strength)
            for source_id, scores in source_scores.items()
        }
        team_stats = {
            key: _stats(key[0], scores, prior_score, prior_strength)
            for key, scores in team_scores.items()
        }
        return cls(source_stats=source_stats, team_stats=team_stats, prior_score=prior_score)

    def source_stat(self, source_id: str) -> SourceStats:
        return self.source_stats.get(
            source_id,
            SourceStats(source_id=source_id, score=self.prior_score, sample_count=0, raw_average=self.prior_score),
        )

    def team_stat(self, source_id: str, team: str) -> SourceStats:
        return self.team_stats.get((source_id, normalize_team(team)), self.source_stat(source_id))

    def weight_for(self, source_id: str, home_team: str, away_team: str) -> float:
        source = self.source_stat(source_id)
        home = self.team_stat(source_id, home_team)
        away = self.team_stat(source_id, away_team)

        team_score = (home.score + away.score) / 2
        blended_score = (0.55 * source.score) + (0.45 * team_score)
        blended_count = max(source.sample_count, round((home.sample_count + away.sample_count) / 2))
        confidence = min(1.0, math.log1p(blended_count) / math.log1p(30)) if blended_count else 0.0
        return max(0.05, blended_score) * (0.35 + 0.65 * confidence)

    def ranked_sources(self) -> list[SourceStats]:
        return sorted(
            self.source_stats.values(),
            key=lambda item: (item.weight_multiplier, item.sample_count, item.score),
            reverse=True,
        )


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _optional_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _stats(source_id: str, scores: list[float], prior_score: float, prior_strength: int) -> SourceStats:
    if not scores:
        return SourceStats(source_id=source_id, score=prior_score, sample_count=0, raw_average=prior_score)

    raw_average = sum(scores) / len(scores)
    smoothed = ((prior_score * prior_strength) + sum(scores)) / (prior_strength + len(scores))
    return SourceStats(source_id=source_id, score=smoothed, sample_count=len(scores), raw_average=raw_average)


def normalize_team(team: str) -> str:
    return " ".join(team.casefold().split())


def score_prediction(record: PredictionRecord) -> float:
    """Return a 0..1 accuracy score for a resolved exact-score prediction."""

    if not record.is_resolved:
        raise ValueError("cannot score unresolved prediction")

    actual_home = record.actual_home_goals or 0
    actual_away = record.actual_away_goals or 0
    predicted_home = record.predicted_home_goals
    predicted_away = record.predicted_away_goals

    exact = 0.35 if (predicted_home, predicted_away) == (actual_home, actual_away) else 0.0
    outcome = 0.25 if _outcome(predicted_home, predicted_away) == _outcome(actual_home, actual_away) else 0.0
    home_goals = 0.15 * _bounded_similarity(predicted_home, actual_home)
    away_goals = 0.15 * _bounded_similarity(predicted_away, actual_away)
    margin = 0.10 * _bounded_similarity(predicted_home - predicted_away, actual_home - actual_away)

    return min(1.0, exact + outcome + home_goals + away_goals + margin)


def aggregate_fixture(
    fixture_id: str,
    records: Iterable[PredictionRecord],
    reliability: ReliabilityIndex,
    max_goals: int = 7,
) -> Forecast:
    current_predictions = [record for record in records if record.fixture_id == fixture_id and not record.is_resolved]
    if not current_predictions:
        raise ValueError(f"no unresolved predictions found for fixture {fixture_id!r}")

    home_team = current_predictions[0].home_team
    away_team = current_predictions[0].away_team

    weighted_home = 0.0
    weighted_away = 0.0
    total_weight = 0.0
    scoreline_mass: dict[Scoreline, float] = defaultdict(float)

    for record in current_predictions:
        weight = reliability.weight_for(record.source_id, record.home_team, record.away_team)
        total_weight += weight
        weighted_home += record.predicted_home_goals * weight
        weighted_away += record.predicted_away_goals * weight
        _add_scoreline_kernel(scoreline_mass, record.predicted_home_goals, record.predicted_away_goals, weight, max_goals)

    if total_weight <= 0:
        raise ValueError(f"fixture {fixture_id!r} has zero usable source weight")

    normalized_mass = _normalize_mass(scoreline_mass)
    home_prob = sum(probability for (home, away), probability in normalized_mass.items() if home > away)
    draw_prob = sum(probability for (home, away), probability in normalized_mass.items() if home == away)
    away_prob = sum(probability for (home, away), probability in normalized_mass.items() if home < away)
    top_scorelines = [
        (home, away, probability)
        for (home, away), probability in sorted(normalized_mass.items(), key=lambda item: item[1], reverse=True)[:5]
    ]

    return Forecast(
        fixture_id=fixture_id,
        home_team=home_team,
        away_team=away_team,
        predicted_home_goals=weighted_home / total_weight,
        predicted_away_goals=weighted_away / total_weight,
        source_count=len(current_predictions),
        total_weight=total_weight,
        home_win_probability=home_prob,
        draw_probability=draw_prob,
        away_win_probability=away_prob,
        top_scorelines=top_scorelines,
    )


def _add_scoreline_kernel(
    mass: dict[Scoreline, float],
    predicted_home: int,
    predicted_away: int,
    source_weight: float,
    max_goals: int,
) -> None:
    for home_delta in (-1, 0, 1):
        for away_delta in (-1, 0, 1):
            home = min(max(predicted_home + home_delta, 0), max_goals)
            away = min(max(predicted_away + away_delta, 0), max_goals)
            distance = abs(home_delta) + abs(away_delta)
            kernel_weight = {0: 1.0, 1: 0.28, 2: 0.08}[distance]
            mass[(home, away)] += source_weight * kernel_weight


def _normalize_mass(mass: dict[Scoreline, float]) -> dict[Scoreline, float]:
    total = sum(mass.values())
    if total <= 0:
        return {}
    return {scoreline: value / total for scoreline, value in mass.items()}


def load_jsonl(path: Path) -> list[PredictionRecord]:
    records: list[PredictionRecord] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                records.append(PredictionRecord.from_mapping(json.loads(stripped)))
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise ValueError(f"{path}:{line_number}: invalid prediction record: {exc}") from exc
    return records


def write_jsonl(path: Path, records: Iterable[PredictionRecord]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record.to_mapping(), sort_keys=True) + "\n")


def _cmd_rank(args: argparse.Namespace) -> int:
    records = load_jsonl(Path(args.predictions))
    reliability = ReliabilityIndex.from_records(records)
    for index, source in enumerate(reliability.ranked_sources()[: args.limit], start=1):
        print(
            f"{index:>2}. {source.source_id:<32} "
            f"score={source.score:.3f} raw={source.raw_average:.3f} n={source.sample_count}"
        )
    return 0


def _cmd_forecast(args: argparse.Namespace) -> int:
    records = load_jsonl(Path(args.predictions))
    reliability = ReliabilityIndex.from_records(records)
    forecast = aggregate_fixture(args.fixture_id, records, reliability)
    print(json.dumps(forecast.to_mapping(), indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="World Cup score prediction weighting prototype")
    subparsers = parser.add_subparsers(required=True)

    rank = subparsers.add_parser("rank-sources", help="rank sources by resolved prediction accuracy")
    rank.add_argument("predictions", help="JSONL prediction ledger")
    rank.add_argument("--limit", type=int, default=20)
    rank.set_defaults(func=_cmd_rank)

    forecast = subparsers.add_parser("forecast", help="forecast one unresolved fixture")
    forecast.add_argument("predictions", help="JSONL prediction ledger")
    forecast.add_argument("fixture_id", help="fixture id to forecast")
    forecast.set_defaults(func=_cmd_forecast)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
