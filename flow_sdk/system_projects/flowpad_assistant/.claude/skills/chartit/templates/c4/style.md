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

| element | shape | colour slot |
|---|---|---|
| person | card with a round head on top | violet `--s4` |
| system, container, component | rounded card, coloured top bar | blue `--s1` |
| code | square-cornered card | blue `--s1` |
| database | cylinder | aqua `--s3` |
| queue | pill | aqua `--s3` |
| anything `external: true` | the same shape, grey fill, dashed outline | neutral `--s-other` |

- **Text on a box:** name (bold, up to 2 lines), tag line `[Container · FastAPI]`, description (up to 3 lines, then `…`). The full text shows on hover and in the Table view.
- **Boundaries:** dashed outline, name and `[kind · tech]` top left. They nest. A boundary with nothing in it is not drawn.
- **Relations:** neutral grey lines with the label on a plate and `[tech]` under it. `async` is dashed. Hovering a box or line lights its links in the focus colour and dims the rest.
- **Dynamic charts** (and any relation with `order`): an orange numbered badge on each arrow.
- **Badges** at the foot of a box: `migrating` (orange) or `target` (dashed); `Open ↗` when the box has `ref`.
- **Layout:** automatic (dagre). Top to bottom, or left to right for dynamic charts; `direction` overrides it.
- **Under the diagram:** a legend of the kinds shown and the line styles. The Table view lists every element and relation.
- **Light and dark** come from the shared token sets.
- **Size:** at most about 20 elements per chart (`check_c4.py` warns past 20). Past that, zoom in with another chart and `ref`.
