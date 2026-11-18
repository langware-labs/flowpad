---
release: 0.2.271
from: v0.2.270
to: HEAD
source_hash: 6fb142970af270ce
---

# Flowpad 0.2.271

*Released Nov 17, 2026*

## Fixed

- **Starting a session** — Claude Code no longer stops each new session to ask whether you trust the folders Flowpad adds to it (its own folders and your project's dependencies). Any other folder still asks once, and the **Trust** button now answers the new question too.
- **Cloud deploy** — a deploy no longer reports failure when the machine actually came up.
