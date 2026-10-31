# C4 chart style — fixed by the editor, not by the chart

The C4 view (`C4ChartView.tsx`, `c4Model.ts`) draws every `c4` chart the same way. A chart's `c4.json`
holds facts only (what exists, how it talks); it never carries a colour, a size or a position. A
review comment asking for a colour or a layout change is answered by changing the data (`kind`,
`external`, `boundary`, `direction`, `status`), never with a one-off style.

Where the rules come from: the `dataviz` skill (the shared chart tokens in `chartTheme.ts`, which the
sequence view uses too) and the `ui-ux-pro-max` skill's guidance for node-and-link charts (searched
with `"network graph node relationship hierarchy" --domain chart`): categorical colour per node
type, neutral links at about 60% opacity, a highlight colour for the active path, shape and line
style as well as colour, a table as the accessible fallback, SVG up to about 100 nodes, keyboard
focus that shows details and Enter to act. Its general style picks (dark-only, neon HUD) do not
fit an in-app chart and are not used.

Every box is a **chip**, the same as a sequence participant card: colour dot · icon · name, and a second
line with its kind and format (`Container · FastAPI`). The icon is the kind's default unless the element
names one.

| kind | shape | colour slot | default icon |
|---|---|---|---|
| person | card with a round head on top | violet `--s4` | `lucide.user` |
| role | rounded card | violet `--s4` | `lucide.badge-check` |
| system, container, component | rounded card, coloured top bar | blue `--s1` | `lucide.boxes` / `lucide.package` / `lucide.layers` |
| api | pill-ended card | blue `--s1` | `lucide.plug` |
| code | square-cornered card | blue `--s1` | `lucide.braces` |
| function | notched card (a step that runs) | blue `--s1` | `lucide.zap` |
| action | notched card | orange `--s2` | `lucide.play` |
| database, storage | cylinder | aqua `--s3` | `lucide.database` / `lucide.archive` |
| queue | pill | aqua `--s3` | `lucide.inbox` |
| anything `external: true` | the same shape, grey fill, dashed outline | neutral `--s-other` | |

- **Text on a box:** the chip line (name up to 2 lines, then kind · format), then the description (up to 3 lines, then `…`). The full text shows on hover and in the Table view.
- **Chips under the text:** `links` (code `path:line`, docs, assets, URLs) and, at code level, typed `inputs` / `returns` — each opens what it names (a data type opens its data_schema).
- **Calling another chart:** a box or arrow with `ref` is drawn as a SUB-CHART (dashed, tagged) with **Open ↗**, the same as a sequence sub-flow. The chart it opens can be any format.
- **Boundaries:** dashed outline, name and `[kind · tech]` top left. They nest. A boundary with nothing in it is not drawn.
- **Relations:** neutral grey lines with the label on a plate, `[tech]` under it, then a `⟨data kind⟩` chip and Open ↗ when set. `async` is dashed. Hovering a box or line lights its links in the focus colour and dims the rest.
- **Dynamic charts** (and any relation with `order`): an orange numbered badge on each arrow.
- **Badges** at the foot of a box: `migrating` (orange) or `target` (dashed); `Open ↗` when the box has `ref`.
- **Layout:** automatic (ELK, nested boundaries never overlap), left to right; `direction: TB` turns it top to bottom.
- **Canvas:** scroll to zoom at the cursor, drag to pan, **Fit** shows the whole chart.
- **Change this:** click any box, arrow or boundary (or **Change chart**) to ask for a change; it lands in the chart's **Changes** side tab, and Execute runs the chart's context worker on the source file. Queued changes show as numbered marks.
- **Under the diagram:** a legend of the kinds shown and the line styles. The Table view lists every element and relation.
- **Light and dark** come from the shared token sets.
- **Size:** at most about 20 elements per chart (`check_c4.py` warns past 20). Past that, zoom in with another chart and `ref`.
