# chartit — the data behind sequence charts, and the feedback on any chart

| kind | a value is |
|---|---|
| `chartit.sequence` | a `format: sequence` Chart's `chart.json`: participants and the messages between them |
| `chartit.participant` | one lifeline of a sequence chart |
| `chartit.message` | one arrow — or, with `ref`, a sub-flow block opening another Chart |
| `chartit.feedback` | one comment a reviewer left on a Chart (any format), optionally on one element of it |

Charts themselves are Flowpad **Chart** entities (`agentic-assets/chart/<name>/`), not rows. Feedback
lives in the project's `chart-feedback` dataset (row key = `<chart name>-<base36 time>`), written only
through the SDK / `dm_ctl`.
