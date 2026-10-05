# Smart navigation, end to end — the user's line and the data scientist's log

**Needs:** an instance from this checkout (`scripts/instance_ctl.sh launch nav-7`), cloud-logged-in
to the local hub (`:8093`) that offers a decision API (an APIEndpoint with `kinds: ["decision"]`, e.g.
Jev).

1. **Off by default.** In the magic line ("What do you want to do?") type `open data sources` →
   Data sources opens, and nothing is added to SmartNavigationLog.
2. **Turn it on.** Preferences → Advanced → **Smart navigation log**.
3. **Use it.**
   - `open data sources` → Data sources opens;
   - `summarize the README` → the assistant opens with that prompt;
   - `take me to preferences` → Preferences opens.
4. **The log.** SmartNavigationLog (Assets / `GET /api/v1/graph/dataset?filter={"name":"SmartNavigationLog"}`)
   has 3 new `train` rows: each with `input.here`, the decision as `output`, what was done in `data`
   (`address` or `prompt`), no gold. Validate reports no problems.
5. **Review.** Open its editor (`/dock/app/<editor>?subject=dataset-<id>`). Filter **needs label**,
   click **Correct** on a row → its gold is written (`ground_truth/decision.json`) and it leaves the
   filter.
6. **Train / evaluate.** `navigator_eval.evaluate(Dataset.at(navigation_log.folder()), kinds=("train",))`
   scores the reviewed rows. Run it with the instance's env (`set -a; . ./.env.<instance>.local`) so the
   process reaches the hub's decision API — without it every row re-runs as `agentic`.
