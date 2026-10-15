# chartit — interactive charts and the feedback on them

| kind | a value is |
|---|---|
| `chartit.chart` | one interactive chart: its type, its data, where it is served, the session that builds it |
| `chartit.sequence` | the data of a sequence (network flow) chart: participants and the messages between them |
| `chartit.participant` | one lifeline of a sequence chart |
| `chartit.message` | one arrow of a sequence chart (from = to: a self-call) |
| `chartit.feedback` | one comment a reviewer left on a chart, optionally on one element of it |

Charts live in the project's `charts` dataset (row key = the chart's slug); feedback in `chart-feedback`
(row key = `<chart>-<base36 time>`). Written only through the SDK / `dm_ctl`.
