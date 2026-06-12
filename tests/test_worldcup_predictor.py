from pathlib import Path

from examples.worldcup_predictor.source_discovery import estimate_source_volume, filter_sources, load_registry
from examples.worldcup_predictor.worldcup_predictor import (
    PredictionRecord,
    ReliabilityIndex,
    aggregate_fixture,
    load_jsonl,
    score_prediction,
)


def _record(
    source_id: str,
    fixture_id: str = "fixture",
    home: str = "Germany",
    away: str = "Japan",
    predicted: tuple[int, int] = (1, 0),
    actual: tuple[int, int] | None = (1, 0),
) -> PredictionRecord:
    actual_home, actual_away = actual if actual is not None else (None, None)
    return PredictionRecord(
        fixture_id=fixture_id,
        source_id=source_id,
        home_team=home,
        away_team=away,
        predicted_home_goals=predicted[0],
        predicted_away_goals=predicted[1],
        actual_home_goals=actual_home,
        actual_away_goals=actual_away,
    )


def test_score_prediction_rewards_exact_score_over_near_result() -> None:
    exact = _record("source", predicted=(2, 1), actual=(2, 1))
    right_result_wrong_score = _record("source", predicted=(1, 0), actual=(2, 1))
    wrong_result = _record("source", predicted=(0, 2), actual=(2, 1))

    assert score_prediction(exact) == 1.0
    assert score_prediction(exact) > score_prediction(right_result_wrong_score)
    assert score_prediction(right_result_wrong_score) > score_prediction(wrong_result)


def test_reliability_index_boosts_team_specialists() -> None:
    records = [
        _record("japan_specialist", fixture_id="old-1", home="Japan", away="Germany", predicted=(2, 1), actual=(2, 1)),
        _record("japan_specialist", fixture_id="old-2", home="Japan", away="Spain", predicted=(1, 0), actual=(1, 0)),
        _record("japan_specialist", fixture_id="old-3", home="Brazil", away="Croatia", predicted=(4, 0), actual=(0, 1)),
        _record("generalist", fixture_id="old-4", home="Brazil", away="Croatia", predicted=(1, 0), actual=(1, 0)),
        _record("generalist", fixture_id="old-5", home="Japan", away="Spain", predicted=(0, 3), actual=(1, 0)),
    ]

    reliability = ReliabilityIndex.from_records(records)

    japan_fixture_weight = reliability.weight_for("japan_specialist", "Japan", "Croatia")
    unrelated_fixture_weight = reliability.weight_for("japan_specialist", "Brazil", "Croatia")

    assert japan_fixture_weight > unrelated_fixture_weight


def test_aggregate_fixture_moves_toward_reliable_source_prediction() -> None:
    records = [
        _record("strong_source", fixture_id="old-1", home="Germany", away="Japan", predicted=(2, 0), actual=(2, 0)),
        _record("strong_source", fixture_id="old-2", home="Germany", away="Spain", predicted=(1, 0), actual=(1, 0)),
        _record("weak_source", fixture_id="old-3", home="Germany", away="Japan", predicted=(0, 3), actual=(2, 0)),
        _record("weak_source", fixture_id="old-4", home="Germany", away="Spain", predicted=(0, 3), actual=(1, 0)),
        _record("strong_source", fixture_id="future", predicted=(3, 0), actual=None),
        _record("weak_source", fixture_id="future", predicted=(0, 2), actual=None),
    ]

    reliability = ReliabilityIndex.from_records(records)
    forecast = aggregate_fixture("future", records, reliability)

    assert forecast.predicted_home_goals > forecast.predicted_away_goals
    assert forecast.home_win_probability > forecast.away_win_probability
    assert forecast.top_scorelines[0][:2] == (3, 0)


def test_load_sample_jsonl_and_forecast() -> None:
    path = Path("examples/worldcup_predictor/sample_predictions.jsonl")
    records = load_jsonl(path)
    reliability = ReliabilityIndex.from_records(records)
    forecast = aggregate_fixture("2026-B-CAN-BIH", records, reliability)

    assert forecast.source_count == 3
    assert forecast.total_weight > 0


def test_source_registry_has_scaling_surfaces() -> None:
    sources = load_registry()
    exact_sources = filter_sources(sources, exact_score_only=True)

    assert len(sources) >= 40
    assert len(exact_sources) >= 20
    assert estimate_source_volume(sources) >= 1000
