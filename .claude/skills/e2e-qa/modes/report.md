# Report Mode

When invoked with `report [results-dir]`:

**No team needed** — the lead handles this directly.

1. If no dir specified, find the latest `_results/<timestamp>/` directory
2. Read all `*.json` result files (exclude `cycle-report.json`)
3. Aggregate into cycle report conforming to `schemas/cycle-report.schema.json`
4. Generate HTML report from `templates/report.html`
5. Open the report in the default browser (`open <path>` on macOS, `xdg-open <path>` on Linux), then print summary and report path
