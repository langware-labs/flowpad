---
id: 49d25850-efb7-55c7-b8bc-12be89037eeb
---

# Trace analysis & skill improvement flow

How a past agent session is **analyzed** into an `AgentTrace`, surfaced in the
UI, and turned into a **skill improvement** (analyze → improve → diff → version).
Two skills do the work — `agent-trace` (analysis) and `skillit` (correction) —
each run as an `AgenticProcess`; the frontend only launches them and renders the
resulting entities.

## The pieces

| Piece | What it is |
| --- | --- |
| **`agent-trace` skill** | Reads a session's transcript(s) and emits an `AgentTrace` record: a verdict + per-asset (`by_skill`) verified findings. Runs as a `ProcessKind.Analysis` process. |
| **`skillit` skill (CORRECT mode)** | Fed an analysis's findings, edits the target `SKILL.md` in place. Runs as a `ProcessKind.Execution` process. |
| **`AgentTrace` entity** | One analysis. Cheap entity-row fields: `verdict`, `verdict_reason`, `issue_count`, `divergence_count`, `cost_usd`, `duration_ms`, `session_id`. The full report (`trace.json`) is a blob behind `asset_ref` / `doc`. |
| **`trace.json` doc** | `annotations.by_skill[<skill>].findings`, `summary` (counts + `cost_usd`), `lanes[].segments[{cost_usd, severity}]`, `summary.skill_drift`. |

> An `AgentTrace` keyed to a `session_id` is the join key for everything below —
> the analysis list, and the improvement processes attached to it.

## 1. Analyze a session → `AgentTrace`

The "Analyze" control lives in the transcript toolbar **and** the terminal
Analysis side-window; both reuse the same hook so the behavior is identical.

```
click "Run" (analysis-run)
  → useAnalysisControls(sessionId).startAnalysis()
  → launchSessionAnalysis(sessionId, workerType)        // skill-eval-analysis.ts
  → ComputeNode('@local').createProcess({ ProcessKind.Analysis, stream-json })
        attach agent-trace skill → prompt:
        "Use the agent-trace skill to analyze session <id> … produce the AgentTrace record."
  → worker walks the transcript, writes an AgentTrace entity (verdict + by_skill findings)
  → notify_updated() → data_op → useSessionAnalyses(sessionId) re-renders the list
```

- **Every run is its own process** (`newSession: true`) → its own history entry;
  previous analyses are kept, never overwritten.
- `useAnalysisControls` derives the toolbar state (`deriveAnalysisAction`) from
  `{traces, analysisProcesses, lastEntryTs}`: **Run** (none yet) → **Analyzing…**
  (a run is active) → **Open + Rerun** (done; offers a fresh run when the session
  has new activity since the last analysis).
- The run itself is watched in a generic `EntityExecutionPanel` drawer
  (`AnalysisSidePanel`).

## 2. Surface the analyses (terminal Analysis side-window)

`AnalysisPanel` (`side-windows/AnalysisPanel.tsx`) lists this process's analyses,
newest first, as **flat, non-expanding rows**:

```
[16 issues] [mixed]                    5d ago
Thorough QA cycle … (verdict_reason)
[✨ Improve]  [↗ Report]
```

- Row content is all **cheap entity-row** fields — no `trace.json` load per row.
- **Report** → `navigation.openDock(trace.editorDockPointer)` opens the full
  `AgentTrace` asset editor (URL-first; the click handler only navigates).
- **Improve** (shown only when `issue_count + divergence_count > 0`) opens a
  **portal modal** — detail lives in an overlay, never an in-row expand, so it
  cannot resize the terminal side-window.

> Design note: an earlier in-row "value chip + expand-below" was removed because
> growing the side-window on click perturbed the xterm layout and tripped the
> terminal's `ResizeObserver` loop. Detail is now a portal (`Dialog`).

## 3. Improve from an analysis (the modal)

`AnalysisImprovementModal` mounts `useAnalysisImprovements(trace)` **only while
open** (so `trace.json` + per-skill `git status` are read lazily, one trace at a
time). It shows the projected value headline and the per-skill Improve controls.

```
useAnalysisImprovements(trace):
  doc        = useAgentTraceDoc(trace.doc)              // trace.json, lazy
  improvable = improvableSkills(doc)                    // by_skill entries with ≥1 finding
  skills[]   = each improvable skill resolved to its Skill entity + SKILL.md ref,
               with status derived from the working tree:
                 dirty SKILL.md         → 'done'   (an edit to review)
                 launched + run active  → 'running'
                 else                   → 'idle'   (offer Improve)
```

Per-skill button states in the modal:

| State | Control | Meaning |
| --- | --- | --- |
| `idle` | **Improve** | `improve(skillName)` → `launchSkillCorrect(...)` |
| `running` | **Improving…** | a `skillit` CORRECT process is active |
| `done` | **Review changes** | SKILL.md is dirty → open the diff modal |

`improve(skillName)` (gated on an **installed skill + a clean SKILL.md** so the
resulting diff is purely the fix):

```
launchSkillCorrect({ targetSkill, sessionId: trace.session_id, findings, analysisTrace: trace })
  → createProcess({ ProcessKind.Execution, targetVfsPath: trace.typeId })   // ← keyed to the TRACE
        attach skillit skill → prompt:
        "Use the skillit skill in CORRECT mode on the skill \"<name>\" …
         Apply these per-asset findings … edit the skill in place: <findings JSON>"
```

The `targetVfsPath: analysisTrace.typeId` is the **attachment link**: the
improvement process is keyed to the analysis (not the skill), so
`useProcessesForTarget(trace.typeId, Execution)` finds it and the modal knows a
run is in flight for that analysis.

### Projected value headline

`projectedRunSavingsUsd(doc)` (pure, in `analysis-improvements.ts`) =
Σ `cost_usd` of the trace's `severity:'attention'` segments — the *measured cost
of the flagged-wasteful work* — with a conservative `cost_usd × 0.15` fallback
only when a run has findings but no per-segment costs. Always labeled
**"projected"** (a measured delta would need a real post-version run).

## 4. Review the diff → save a version

`done` → **Review changes** opens `ImprovementResultsModal`, which renders the
working-tree edit via the shared `AssetDiffTabs` (Review + Code tabs) by
fetching, in parallel:

- `git-ops/show {hash: HEAD}` — the committed SKILL.md, and
- a working-tree read — the edited SKILL.md, and
- `git-ops/diff {status: 'M'}` — `git diff HEAD -- <file>` (working-tree diff).

Footer actions:

| Action | Backend | Effect |
| --- | --- | --- |
| **Reject** | `git-ops/discard-file` | restore SKILL.md to HEAD |
| **Save & create version** | `commit-asset` | commit the edit + bump the skill version |

On commit/discard the modal calls `refreshDirty()` → the per-skill `git status`
re-reads → the row flips back to `idle` (ready for the next cycle).

## The loop (analyze → improve → version → re-analyze)

A skill converges over **at most `MAX_IMPROVE_CYCLES` (3)** cycles; the pure
`shouldRunAnotherCycle({cycleCount, priorCycleDirty, analysisDoc})` owns the stop
decision — stop when the cap is hit, the prior cycle left an unsaved edit
(commit/review first), or the latest analysis surfaced **no** improvable skills
(converged). The loop driver (a test, or a future UI) owns the I/O; the function
owns only the decision.

```
analyze ──► AgentTrace (issues>0?) ──► improve (skillit CORRECT) ──► diff ──► commit (vN+1)
   ▲                                                                              │
   └───────────────── re-analyze; stop when clean or cap reached ◄───────────────┘
```

## Where each piece lives

| Concern | File |
| --- | --- |
| Launch analyze / improve / test | `ui/src/components/assets/editor/skill/skill-eval-analysis.ts` |
| Toolbar Run/Analyzing/Rerun + run drawer | `ui/src/.../transcript-features/AnalysisControls.tsx` |
| Analysis list (flat rows) + improve modal | `ui/src/.../side-windows/AnalysisPanel.tsx` |
| Per-analysis improvement state | `ui/src/.../side-windows/useAnalysisImprovements.ts` |
| Pure derivations (improvable set, dirtiness, projection, loop policy) | `ui/src/.../side-windows/analysis-improvements.ts` |
| Diff + accept/reject/version modal | `ui/src/.../side-windows/ImprovementResultsModal.tsx` |
| Shared diff tabs (Review + Code) | `ui/src/components/assets/editor/revisions/AssetDiffTabs.tsx` |
| Full report editor | `ui/src/components/assets/editor/agent-trace/` |
| `agent-trace` skill learnings | `.flow/skills/agent-trace/instructions.md` |

No backend route is added by this flow — `agent-trace`/`skillit` run as ordinary
workers, and `git-ops`, `commit-asset`, `discard-file` already exist. The value
layer is pure derivation + render; the frontend launches actions and renders the
resulting entities, nothing more.
