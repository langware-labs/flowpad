---
type: markdown_index
id: markdown_index-b91806c7-b7c9-5289-8493-a79f197f9c51
inputs_hash: aa4c30953e0ff57260aa2687888c5a0f48a8ab2b623275f209926b5b4a6df0d2
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-11-11T06:55:22.978113+00:00'
latest_process_ref: ''
file_count: 5
subfolder_count: 0
---

# navigation

## Self-Summary
> How Flowpad navigates: the seven-step dock URL loading algorithm and its invariants, the screen map with you-are-here context and where-to-go routing, the home page a project opens on, and the catalogs of example sentences each mapped to its navigation target.

## Files
- [Dock loading — one algorithm, seven steps](dock-loading.md) — Dock loading contract: seven steps parse, canonicalize, resolve, commit, layout, render, attach for every /dock URL, with invariants and their enforcing tests.
- [Navigation sentences — the whole Flowpad UX surface](navigation-sentences.md) — Two hundred navigation requests mapped to screens, entities, files, URLs, logs, or assistant actions for classifier coverage.
- [Navigation spec — the map, you are here, where to go](navigation-spec.md) — Navigation spec: the screen map, the you-are-here context, the NavigationDecision routing to a dock or assistant prompt, and the SmartNavigationLog dataset.
- [Smart navigation — 200 medium sentences](navigation_medium.md) — Two hundred contextual navigation sentences covering indirect wording, typos, source screens, expected destinations, and assistant handoffs.
- [Project home page — what a project opens on](project-home-page.md) — Project home page: home_page in project_manifest.json naming an agent or webapp asset by TypeId or ./ path, resolution rules, and what Home opens.
