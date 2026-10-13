---
type: markdown_index
id: markdown_index-b91806c7-b7c9-5289-8493-a79f197f9c51
inputs_hash: 1723a9d033623b559b0456fbc24db7541c5ba64869dd2b3c5f1e01c1b070df25
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/alice/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-13T10:49:35Z'
latest_process_ref: ''
file_count: 5
subfolder_count: 0
---

# navigation

## Self-Summary
> How Flowpad navigates: the seven-step dock URL loading algorithm and its invariants, the screen map with you-are-here context and where-to-go routing, the home page a project opens on, and the catalogs of example sentences each mapped to its navigation target.

## Files
- [Dock loading — one algorithm, seven steps](dock-loading.md) — Seven-step dock URL loading algorithm (parse, canonicalize, resolve, commit, layout, render, attach), its six invariants, enforcing tests, PTY replay checkpoints, past traps and speed budgets.
- [Navigation sentences — the whole Flowpad UX surface](navigation-sentences.md) — Catalog of 200 example magic-line sentences covering every Flowpad screen, tab and action, each mapped to its navigation target, used as the classifier's coverage map.
- [Navigation spec — the map, you are here, where to go](navigation-spec.md) — Navigation spec: the screen map, the you-are-here context, the NavigationDecision routing to a dock or assistant prompt, and the SmartNavigationLog dataset.
- [Smart navigation — 200 medium sentences](navigation_medium.md) — Second smart-navigator eval suite: 200 medium-difficulty magic-line sentences in twenty app-area groups, each with its starting dock address and expected target.
- [Project home page — what a project opens on](project-home-page.md) — Project home page: home_page manifest declaration naming an agent or web app, how it is set, resolved and loaded, and when the redirect opens it.
