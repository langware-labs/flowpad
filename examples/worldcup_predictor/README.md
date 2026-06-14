---
id: 8a4d3fa0-e3f3-570c-a26b-f44e06817e9a
---

# World Cup Winner and Score Predictor Prototype

This example is a research-grade starting point for a World Cup predictor that learns which sources are accurate overall and which sources are especially good for specific teams.

## What It Does

- Stores every exact-score prediction as one JSONL record.
- Scores resolved predictions against actual results.
- Builds source reliability globally and per source/team pair.
- Weights unresolved predictions by learned reliability.
- Produces a weighted score forecast plus top likely scorelines.
- Maintains a seed registry of prediction sources discovered from sports sites, model publishers, prediction pools, Reddit, X, YouTube, APIs, and datasets.

## Run It

```bash
python -m examples.worldcup_predictor.source_discovery validate
python -m examples.worldcup_predictor.source_discovery list --exact-score-only
python -m examples.worldcup_predictor.worldcup_predictor rank-sources examples/worldcup_predictor/sample_predictions.jsonl
python -m examples.worldcup_predictor.worldcup_predictor forecast examples/worldcup_predictor/sample_predictions.jsonl 2026-B-CAN-BIH
```

## Data Contract

Each prediction is one line of JSON:

```json
{"fixture_id":"2026-B-CAN-BIH","source_id":"oddsline","home_team":"Canada","away_team":"Bosnia-Herzegovina","predicted_home_goals":2,"predicted_away_goals":1,"predicted_at":"2026-06-12T12:00:00Z","source_url":"https://oddsline.io/world-cup-predictions-today/"}
```

When the result is known, add:

```json
{"actual_home_goals":2,"actual_away_goals":0}
```

## Accuracy Model

The score for a resolved prediction is a 0..1 blend:

- exact score match
- correct outcome: home win, draw, or away win
- home-goal closeness
- away-goal closeness
- goal-margin closeness

The reliability index uses Bayesian smoothing so a source is not over-weighted after one lucky exact score. It stores:

- global source reliability
- per-team reliability for each source
- confidence based on sample size

For a future game, the source weight blends global reliability with the two team-specific reliabilities. This is the piece that captures "some fans/sources specialize in some teams."

## Source Strategy

The seed registry is intentionally split into source surfaces:

- Exact-score publishers: Forebet, OddsLine, FootballPredictions.com, PredictZ, ProTipster, Squawka, etc.
- Probability/model publishers: Opta Analyst, Silver Bulletin, R-Bloggers, Economics Observatory, Wolfram Community.
- Prediction pools/competitions: Superbru, Prodefy, DataCamp, Kaggle, Predictify.
- Communities: r/SoccerBetting, r/sportsanalytics, r/worldcup, team subreddits.
- Social/video: X accounts and YouTube creators.
- Truth-data APIs: API-Football, Sportmonks, TheStatsAPI, Statorium, Football-Data.org, OpenFootball.

Do not fake 1000 sources. The scalable way to reach 1000 is to collect many individual authors from Reddit/X/YouTube/prediction pools and score them as separate `source_id`s after results arrive.

## Next Integrations

- Add official fixture/result ingestion from one licensed API.
- Add Reddit API collection that extracts exact score patterns from posts/comments.
- Add X API or approved export ingestion for tipster accounts and hashtags.
- Add YouTube transcript ingestion for prediction videos.
- Add a deduper so one person reposting the same prediction on multiple platforms is not counted twice.
- Promote the module into a Flowpad entity/UI once the data pipeline proves useful.
