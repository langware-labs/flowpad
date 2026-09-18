# Filesystem asset library consolidation — 2026-09-13

The public filesystem library is `flow_sdk/assets`. Application code selects and
authorizes roots, executes provider/Git commands, and maintains projections. It
calls the library for enumeration, identity, decoding, creation, document edits,
installation, removal, scaffolding and portable materialization.

`Asset` identifies a filesystem occurrence. Copies and final symlinks can share a
TypeId while retaining different paths. `Asset.from_typeid` requires an explicit
filesystem records root; it follows the record's path and validates identity.
There is no index lookup or instance-count service in the asset library.

## Implementation checks

- Fresh-interpreter tests forbid imports of application services, Entities,
  settings, database and indexer code while exercising registry discovery,
  enumeration, creation, installation, removal, document edits and record lookup.
  They also reject subprocess and network calls during these operations.
- Filesystem tests cover identity adoption, same-ID occurrences, symlinks,
  collisions, overlapping destinations, concurrent creators, rollback, partial
  scaffolds and preservation of authored files.
- Document tests cover structured/unknown YAML, malformed headers, capsule
  preservation, revision conflicts, concurrent writes and shared writer locks.
- Process tests distinguish folder presence, attachments, native worker
  availability and historical use. Failed native inspection retains readable
  catalog entries and diagnostics without asserting verified availability.
- Resolver tests prove navigation is read-only and optional Entity projection
  failure preserves the address of a readable Markdown document.

## Browser validation

Used an isolated sandbox at `/tmp/flowpad-assets-browser-20260912`, backend 6092
and frontend 5092. The project contains an `Asset Validator` process and separate
project, user and context roots. No worker prompt was sent during validation.

| Case | Observed result |
| --- | --- |
| User and project skills | Both visible in the process inventory. |
| Extra context folder | Context skill visible alongside project/user assets. |
| Alternate harness mount | `.agents` copy appears independently of `.claude` source. |
| Same-ID copy | Selected copy preview reads its own body. |
| Final symlink occurrence | Alias remains a separate inventory occurrence. |
| Dangling symlink | Scan/native-inspection warning is visible; valid entries remain listed. |
| Native and nested assets | MCP and Journey-nested skill remain visible. |
| Exact-occurrence edit | Editing the copy changes only that file; source and structured header remain intact. |
| External edit conflict | Save returns 409, retains the browser draft, and does not overwrite disk; explicit discard reloads disk text. |
| Quick Create destination | Selecting `.github/skills` creates one skill there, with no implicit copies in other harness folders. |
| Malformed YAML | Body remains readable, metadata warning appears, resolution leaves bytes unchanged. |
| Invalid typed metadata | Optional Entity projection failure shows a warning and readable document fallback. |
| Journey display | Native Journey editor renders its step view. |
| Attached occurrence | Installed user skill appears under Attached assets independently of its user-scope source. |

Browser evidence was captured as `asset-validator-inventory.png`,
`asset-validator-conflict.png`, `asset-validator-malformed.png`, and
`asset-validator-journey.png` in the original checkout. The final isolated-runtime
recheck is captured in `asset-validator-final.png`. These are local QA
artifacts. Journey execution was not exercised. The attached skill is visible in the final inventory; native availability
remains unverified because the deliberately broken link makes provider inspection
fail. Attachment receipts and ownership are covered by
filesystem/process tests.

## Asset-only validation before integration

The original
shared checkout contained concurrent process-naming work, so the commit was
prepared in `/tmp/flowpad-asset-library-final` on
`refactor/filesystem-asset-library` to keep its changes separate.

- Backend unit: **9,132 passed, 21 skipped, 3 xfailed**.
- Backend API: **992 passed, 3 skipped**.
- Frontend unit: **5,605 passed**: 4,867 in the full run plus 738 PTY replay
  cases after copying the existing untracked recording fixtures to the isolated
  checkout. No frontend test file remains unvalidated.
- Frontend type check and production build: passed.
- Live SDK document API: **4 passed**, including stale writes and exact Whiteboard repair.
- Focused asset/resolver/repair checks: **167 passed**; isolated regression selection: **56 passed**.
- Final malformed-inventory fix: **173 passed**, including two new process-catalog
  regressions for invalid YAML and parent references. This focused run follows
  the full backend run; the entire suite was not repeated for that final fix.
- Post-import cleanup: **41 passed**.
- Asset library, filesystem schemas and new application adapters: Ruff passed.
- Repository-wide frontend lint already fails at the base revision: 395 errors,
  1,183 warnings. The refactor initially yielded 389 errors and 1,180 warnings;
  its two newly introduced test-double errors were fixed and verified directly (final delta: 387 errors, 1,180 warnings).
  No new lint diagnostics remain relative to that baseline.

## Combined branch validation — 2026-09-13

Integrated asset commit `8ad402638` with shared branch head `d4bc3520f` in
`/tmp/flowpad-assets-integrated`. The merge retains the three intervening
session-naming commits. Four conflict resolutions preserve the naming adapters,
canonical history names, relocated transcript readers and WorkerStatus imports.
The shared checkout's QA instructions and WhatsApp demo are outside this commit.

The final simplification makes catalog diagnostics accumulation explicit. The
combined checks also found old test assumptions: process-status spies counted
initial naming migration, the queue test waited for permanent observers, and
profile/Whiteboard mocks still implemented raw file writes. Those tests now
exercise the document API and clean up their own naming subscriptions. API
fixtures use dedicated home directories; API files run serially in separate
processes to isolate SDK module resets and outstanding realm callbacks.

- Backend unit: **9,180 passed, 21 skipped, 2 xfailed, 1 xpassed** (zero failures).
- Backend API: **992 passed, 3 skipped**.
- Frontend unit: **5,617 passed**, including the local PTY recording fixtures.
- Live SDK API: **247 passed, 9 skipped** across 54 passing files.
- React: **598 passed, 7 skipped** across all 115 files; no unhandled errors.
- Headless full-app UI: **4 passed**, including the skill edit round trip.
- Playwright context-folder scenario: **1 passed**.
- Frontend type check, production build and catalog drift check: passed.
- Asset library, filesystem schemas, binding adapter and changed process tests:
  Ruff passed. Changed React document mocks also pass their lint checks.

The combined browser run opened Asset Validator on frontend 5097/backend 6097.
It showed user/project/context skills, alternate copies, a symlink occurrence,
the nested Journey skill, native MCP and SubAgent. Both malformed candidates
remained visible alongside healthy entries and scan/provider diagnostics.
Screenshot: `/tmp/asset-combined-inventory.png`. The earlier 14-case edit,
conflict, repair and destination matrix remains recorded above. No model prompt
was submitted. Tests ran on disposable backends; restart-dependent and external
provider/hub tiers were not part of this local validation.

## Practical limits

Locks coordinate Flowpad writers. External programs do not participate, and an
ordinary filesystem replacement is not absolute compare-and-swap against an
external writer. Remote editing requires storage-side conditional-write support;
unsupported transports fail explicitly instead of uploading blindly.
