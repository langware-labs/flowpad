---
release: 0.2.278
from: v0.2.277
to: HEAD
source_hash: 77d36a17b763521b
---

# Flowpad 0.2.278

*Released Nov 22, 2026*

## New
- **LinkedIn messages** — read and answer LinkedIn conversations as a channel, with videos, images and files shown in the conversation.
- **Statements cards** — statement docs show as cards in the editor, with requirements, issues and references as tabs; add, delete and edit sentences in place.
- **Image and video generation** — endpoint blocks generate images and video through a hub API endpoint.
- **Remote control by passkey** — each person gets an access key, and a machine can be turned on by fingerprint for a chosen time.
- **Quick prompt folders** — group prompts in folders, drag to move and order them, and pick a note's colour.

## Improved
- The Activity panel lists processes grouped by status; each row opens its tab.
- A page left open across an update offers a reload instead of breaking.
- A clear divider separates the tabs from the tab-bar controls.
- Endpoint calls say why they failed, and survive a connection that drops while the vendor works.

## Fixed
- First-run setup no longer reports git, Python and Node as missing when they are installed.
- Profile pictures load again.
- An asset whose files link outside its repository is refused when pushed.
- Mock comments no longer crash the element-comment panel.
