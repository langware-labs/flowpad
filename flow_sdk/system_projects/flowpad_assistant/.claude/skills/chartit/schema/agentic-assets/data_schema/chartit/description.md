# chartit — the data behind sequence, C4 and architecture charts

| kind | a value is |
|---|---|
| `chartit.sequence` | a `format: sequence` Chart's `chart.json`: participants and the messages between them |
| `chartit.participant` | one lifeline of a sequence chart |
| `chartit.message` | one arrow — or, with `ref`, a sub-flow block opening another Chart |
| `chartit.c4` | a `format: c4` Chart's `c4.json`: elements, boundaries and relations at one C4 level |
| `chartit.c4_element` | one box: a person, system, container, database, queue, component or code unit |
| `chartit.c4_boundary` | one dashed group boxes sit in; nests through `parent` |
| `chartit.c4_relation` | one arrow between two elements |
| `chartit.c4_link` | a link chip on a box or arrow: code, doc, asset or URL |
| `chartit.c4_param` | one typed input of a code-level element |
| `chartit.architecture` | a `format: architecture` Chart's `architecture.json`: groups, tiers, parts, links, steps |
| `chartit.architecture_group` | one outer box: where things run |
| `chartit.architecture_tier` | one dashed tier inside a group |
| `chartit.architecture_part` | one client, service, store, worker or outside system |
| `chartit.architecture_link` | one arrow between parts, tiers or groups |
| `chartit.architecture_step` | one numbered step of the walk-through |

Charts themselves are Flowpad **Chart** entities (`agentic-assets/chart/<name>/`), not rows; these kinds
check a chart's source file (`c4.json`, `chart.json`, `architecture.json`).
