# architecture — the look (fixed by the editor)

The file holds facts only; never a colour, size or position.

| element | drawn as |
|---|---|
| group | solid orange box, name centred on top, `sublabel` under it; groups sit left to right in file order |
| tier | dashed grey box inside its group, name top left; tiers stack top to bottom |
| part | a rounded square in its role's colour with a white glyph, the name and `sublabel` under it |
| step | a numbered circle at the part's top left; clicking it opens the steps list |
| link | a grey orthogonal arrow, the label on a plate at its middle; `dashed` for async / optional; `both` for two-way |
| `ref` | an **Open ↗** pill beside the part |

| role | colour | glyph |
|---|---|---|
| `client` | violet | app window |
| `service` | orange | server |
| `db` | blue | database |
| `files` | teal | folder |
| `worker` | green | cog |
| `external` | pink | cloud |
