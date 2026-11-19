---
release: 0.2.273
from: v0.2.272
to: HEAD
source_hash: e3cdc3d5d87b208e
---

# Flowpad 0.2.273

*Released Nov 18, 2026*

## Improved
- **Reliability** — The hub and cloud sandboxes now send crash reports when something breaks in the browser, so we can find and fix problems faster. Reports carry only the kind of error and where it happened in the code, never your messages, prompts or file contents. The desktop app never sends them, and nothing is sent while privacy mode is set to Local.
