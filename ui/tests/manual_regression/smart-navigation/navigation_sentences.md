# Navigation sentences — stress eval in the browser

Types every sentence of `docs/navigation/navigation-sentences.md` (200) into the magic line of a
running instance and scores it: **1 works · 2 does not work, can work with the current
architecture · 3 impossible with the current architecture** (+ reason). Each run must leave a
SmartNavigationLog row; its example id goes on the board for later analysis and eval.

**Needs:** an instance from this checkout with Smart navigation log ON (Preferences > Advanced),
cloud-logged-in to a hub that offers a decision API.

    cd ui && VITE_PORT=5021 FLOW_INSTANCE=nav-7 npx playwright test \
      --config tests/manual_regression/smart-navigation/playwright.config.ts navigation_sentences

Resume after a stop without losing rows: `NAV_RESUME=1 … -g "\s(158|159|…)\. "`.

**Output** (git-ignored): `ui/tests/manual_regression/_results/navigation-scoreboard.md` (per-group
counts + one row per sentence: score, reason, where it landed, log example id) and `.jsonl`.
