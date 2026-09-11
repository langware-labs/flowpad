# Filesystem asset refactor validation

Date: 2026-09-11.

The filesystem API and ownership boundary are documented in
[asset management](../data-management/asset-management.md). Asset discovery,
identity reading, installation, removal, process projection, usage resolution,
and native inventory decoding live in `flow_sdk/assets`. Application adapters
supply scope paths and handle process state, Entity projection, indexing, and
hub transport.

## Automated validation

- Final combined unit/API suite after all fixes: **10,028 passed**, 24 skipped,
  47 deselected, two expected failures and one unexpected pass; **zero failures**.
  Command: `uv run pytest -q tests/unit tests/api --disable-warnings --maxfail=5`.
  Completed in 589.67 seconds.
- Cumulative implementation asset gate: **203 passed**,
  covering the assets package, process usage and receipts, native discovery,
  process inventory, and published-install API tests.
- Final UI gate after the simplify pass: **40 passed** across asset descriptors, asset manager,
  process inventory hook, occurrence editor, Markdown edit marking, and plain
  Markdown headers, MCP occurrences, and generic read-only previews. Production
  build, TypeScript (both projects), scoped ESLint, asset-package Ruff, and
  `git diff --check` passed.
- Generated-content write failures preserve the previous file and ownership
  receipt. Serialized Asset/AssetUsage values roundtrip and reject a file whose
  identity changed. These final regressions are included in the asset gate.

The initial full run exposed two Codex test fixtures sharing a session directory
and a persona migration test calling a removed helper. The fixtures now isolate
their directories; the migration test calls the actual runtime adapter with its
original assertions intact. Broader API validation corrected an obsolete
asset-usage route in a test and made PTY tests address the configured `@local`
node explicitly, preserving their behavior assertions. Counts above are
separate, overlapping test gates,
not additive totals. No test timeout or retry budget was increased.

After merging `release/v0.2` at `ca7922f23`, all four backend unit CI shards
(including their `--long` cases) and the backend API job passed. The complete
frontend unit gate then passed **5,619 tests across 605 files**. That broader
gate repaired stale toast and terminal mocks, preserved browser Blob/File
compatibility in shared test setup, and restored the current project's empty
bookmark bucket so its first bookmark can be added. Translation catalogs were
extracted and a repeat extraction produced no drift.

The completion audit maps the approved blocks to executable regressions:

| Contract | Regression coverage |
| --- | --- |
| Filesystem identity and exact-destination install | `test_asset_filesystem`, `test_asset_install` |
| Declared mounts, nested assets, diagnostics | `test_asset_enumeration_matrix` |
| Public process usage and unresolved evidence | `test_process_used_assets` |
| Native availability and launch configuration | `test_worker_asset_discovery`, `test_asset_availability` |
| Attachment ownership and atomic projection | `test_process_asset_receipts`, `test_generated_projection_atomic` |
| Bundle transfer, cleanup, versioning, publishing | `test_asset_transfer`, `test_asset_cleanup_scan`, `test_asset_versioning`, published-install API tests |
| SDK dependency boundary | `test_package_boundary` |
| Occurrence navigation and read-only display | Asset-manager, occurrence-editor, MCP, and generic-preview UI tests |

## Browser fixture

An isolated backend on port 6019 and frontend on port 5019 host the **Asset
validator** project/process. Chrome was opened against that frontend. All files
and records are in a temporary test sandbox, including its user assets. The
test uses real filesystem assets and a synthetic native-format transcript;
no model prompt was sent. This verifies rendering and transcript attribution,
not a live worker's historical cache or its ability to invoke every asset.
The terminal attempted to resume the synthetic session and reported that it
was not a real conversation; that is separate from the asset inventory probe.

| Case | Expected presentation |
| --- | --- |
| Project skill read in transcript | Used assets |
| Project skill without usage | Available assets |
| User skill | Available assets, user source |
| Additional-directory skill | Available assets, additional-directory source |
| First copy with a shared TypeId | Separate used occurrence at project path |
| Second copy with the same TypeId | Separate used occurrence at context path |
| Attached unused skill symlink | Attached assets; attachment is not usage |
| Project SubAgent read in transcript | Used assets, subagent type |
| Project Markdown document read in transcript | Used assets, document type |
| Project MCP read in transcript | Used assets; no availability claim from reading |
| Deleted skill with transcript evidence | Unresolved usage, missing path retained |
| Unindexed filesystem spec | Used assets, spec type; its main document opens |
| Task folder | Used assets; read-only main document without metadata headers |
| Workflow bundled inside a skill | Separate dynamic-workflow usage; supporting files remain skill usage |
| Graph workflow folder | Used assets; read-only graph JSON from selected folder |
| Second installed MCP with the same TypeId | Separate context occurrence; its own configuration opens |

The expanded normal response has 16 asset rows (the attached symlink and its physical
source are distinct observations) and twelve grouped usage records, including
one unresolved deleted asset. Both copies retain the same TypeId and different
paths. A temporary malformed MCP identity capsule exercises the seventeenth case:
the browser shows **Could not verify available assets** while retaining all
twelve historical usage records. The malformed fixture is removed afterward.

Browser checks found scope attribution missing for transcript-only project
documents and occurrence navigation dropping the clicked path when two copies
shared an ID. These findings are covered by regression tests in the refactor.
The corrected click opens the selected occurrence's VFS URL. Chrome confirms
the second copy's own body and `contenteditable="false"` in read-only mode,
with editing, deletion, and publishing controls absent from the editor toolbar.
The MCP copy opens its own name/configuration with read-only fields and no test
or publish action. Task and graph-folder clicks open their own main document;
Markdown preview hides the identity header. A React rendering failure during
active HMR did not recur after a clean reload;
no speculative icon changes were made.

## Enumeration matrix and cleanup

The registry-derived test matrix exercises every path-addressable declared
mount, including wildcard mounts, alternate providers, fixed instruction files,
and nested assets. Keyed entries (`claude_hook`, `mcp_server`, `plugin`) and
runtime-only types without declared mounts (`claude_memory`, `project`,
`workflow_run`) are explicitly outside this filesystem-enumeration contract.
The matrix also covers broken mount links, symlink cycles, overlapping roots,
missing main documents, malformed carriers, and singleton destinations. Empty
folders and dependency-only manifests do not count as identity carriers; a
113-test core/install gate covers that final scanner regression.

Validation fixed missed nested assets and bundled workflows, database-only spec
listing, occurrence previews selecting the primary copy, and generic previews
showing metadata. Service triggers were also incorrectly materializing capsule-only
folders: `Trigger.is_file_backed()` now preserves their documented row-only
behavior; document-backed triggers remain assets. Existing incomplete folders are
still reported as errors, never silently erased. Only this temporary browser
sandbox's generated artifacts and stale references were repaired for the fixture.

The simplify pass reused shared deletion and frontmatter helpers, removed dead
process helpers and duplicate materialization steps, and eliminated repeated
usage-evidence copying and serialization. Focused gates after cleanup passed:
137 core/trigger tests, 98 process tests, 29 caller tests, and 41 activity tests.
These gates overlap; their counts are not additive.

Repository-wide UI lint is not clean: the monolithic run exhausted its default
heap. Running the unchanged rules in file batches reported 395 errors and 1,191
warnings outside the changed files. The changed UI files pass scoped ESLint;
no rules or memory/timeout budgets were widened.

## Limits

Native availability remains provider-specific. See
[worker availability](worker-asset-availability.md) and
[CLI drivers](../interface/cli-drivers.md) for unsupported inventory cases and
physical-path precision. Current native observations are not historical usage
evidence. A provider's physical-path report does not prove which symlink alias
was used, and the UI must not mark every alias available by inference.
