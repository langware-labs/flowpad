# chartit — the data behind sequence and C4 charts, and the feedback on any chart

| kind | a value is |
|---|---|
| `chartit.sequence` | a `format: sequence` Chart's `chart.json`: participants and the messages between them |
| `chartit.participant` | one lifeline of a sequence chart |
| `chartit.message` | one arrow — or, with `ref`, a sub-flow block opening another Chart |
| `chartit.c4` | a `format: c4` Chart's `c4.json`: elements, boundaries and relations at one C4 level |
| `chartit.c4_element` | one box: a person, system, container, database, queue, component or code unit |
| `chartit.c4_boundary` | one dashed group boxes sit in; nests through `parent` |
| `chartit.c4_relation` | one arrow between two elements |
| `chartit.feedback` | one comment a reviewer left on a Chart (any format), optionally on one element of it |

Charts themselves are Flowpad **Chart** entities (`agentic-assets/chart/<name>/`), not rows. Feedback
lives in the project's `chart-feedback` dataset (row key = `<chart name>-<base36 time>`), written only
through the SDK / `dm_ctl`.
