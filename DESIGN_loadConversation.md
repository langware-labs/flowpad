# Design: `loadConversation(pointer: DockPointer)` Loader

## Context

A conversation may depend on a parent Task and indirectly on a Project. The loader must resolve these dependencies while preserving the **best-effort cascade pattern** observed across the codebase (Task → Project fallback; silent continue on missing task).

**URLs:**
- `/dock/conversation/<conversationId>` — standalone conversation (most common)
- `/dock/conversation/<conversationId>/message/<messageId>` — deep-link to a message (view-level state, loader ignores tail)
- `/dock/tasks/<taskId>/conversation/<conversationId>` — conversation embedded in task view (handled by `loadTasksRoute`)
- `/dock/project/<projectId>/conversation/<conversationId>` — conversation embedded in project view (handled by `loadProjectRoute`)

## Questions Answered

### 1. Should task + project load in series or parallel?

**Answer: Series (task → project), but only when task exists.**

**Rationale:**
- Task lookup is cache-first via `conv.firstContextOfType('task')` — O(1) check
- Project dependency is **always** via `task.project_id ?? conv.project_id`, so task resolution must complete before project resolution
- Parallel fetch would complicate error semantics: if task fails but project succeeds, the state is inconsistent (active project without active task)
- Pattern is established: `loadTasksRoute` (lines 110–132) does `await loadTask(taskId)`, then `await loadConversation(conversationId)` — sequential within route scope, not parallel within primitive

### 2. If task load fails (404), should conversation fail entirely, or return conversation-only?

**Answer: Return conversation-only. Silent-fail on task 404.**

**Rationale:**
- Current code already does this (lines 65–68): `firstContextOfType('task')` returns `null` if not found, no throw
- Conversations exist independently of tasks: project-scoped chats, hub-direct conversations, and late-joiner shares all lack a parent task
- Precedent: load-process.ts soft-fails on `project_missing` — entity exists, context is incomplete → show page, let user recover
- **Precedent conflict resolution**: Unlike `project_missing` (runtime effect: PTY broken), task 404 has **zero effect** on conversation rendering — the page renders identically whether task existed and loaded or didn't exist at all
- **Therefore**: silent continue is safe; no banner required

### 3. How do we detect which task/project to load from the conversation?

**Answer: From `conv.firstContextOfType('task')` and field chain `task.project_id ?? conv.project_id`.**

**Details:**
- **Task resolution**: `conv.shared_context_entities` (wire field `_shared_context_entities_`) contains a TypeId[] list; `firstContextOfType('task')` returns the first match or null
  - Populated by backend via `shared_context_entities` parameter on create or `add_private_context_entities()` action
  - For hub-received conversations, the task link rides in the bundle's `shared_context_entities` array
- **Project resolution** (in order of precedence):
  1. `task.project_id` (if task loaded) — task owns the project mapping
  2. `conv.project_id` (fallback) — receiver-mapped project (set by ProjectMappingGate or explicit set)
  3. `null` — no project context; UI shows red "Select Project" pill

**Source of truth:** API response carries these fields as-is; no recomputation needed.

### 4. Cache: if conversation is in cache but task is not, do we refresh conversation?

**Answer: No. Use cache-first, no refresh.**

**Rationale:**
- Conversation is immutable for this loader's purposes (message_ids and message_count are projections, user doesn't edit them)
- Task context link is stable: once `conv.firstContextOfType('task')` returns a TypeId, it remains in `_shared_context_entities_` until explicitly removed
- Refresh would add latency (network hop) with zero payoff — the task 404 will fail anyway if it was deleted
- Pattern: All loaders use cache-first (dataManager.getByTypeId).catch(() => null) → no retry loop, no refresh

### 5. Should cascading be implicit in `loadConversation`, or explicit in the caller?

**Answer: Implicit in primitive; explicit control at route level.**

**Two-tier structure (mirrors load-shell.ts + load-project.ts):**

1. **Pure primitive `loadConversation(conversationId)`** (lines 55–110):
   - Fetches conversation
   - Resolves task context (silent fail)
   - Resolves project context (task.project_id → conv.project_id → null)
   - Prefetches Project entity (best-effort)
   - Writes dataContext (active entity, project, workdir)
   - Throws only `ConversationLoadError('not_found', id)` on conversation 404
   - **Implicit cascading**: task and project are resolved internally; caller sees a fully-populated conversation + context

2. **Route wrapper `loadConversationRoute(pointer)`** (lines 116–137):
   - Parses pointer (head segment only)
   - Calls `loadConversation(conversationId)`
   - Catches `ConversationLoadError` → does NOT throw (lets component handle gracefully)
   - Returns void (no return value exposure to caller)

This mirrors the existing pattern:
- `loadProject` / `loadProjectRoute` (load-project.ts:55–221)
- `loadTask` / `loadTasksRoute` (load-tasks.ts:48–133)
- `loadShell` / `loadShellRoute` (load-shell.ts:28–122)

### 6. Timeout strategy for cascade?

**Answer: No explicit timeout. Inherit network + cache behavior.**

**Rationale:**
- HTTP fetch timeouts are configured globally in the axios/fetch layer (SDK responsibility, not loader responsibility)
- Per CLAUDE.md: **"Never raise timeouts/retries to mask symptoms"** — if fetch is slow, the code is slow, not the timeout too short
- Cascade has exactly 2 fetches (task via TypeId, project via TypeId) — parallel they'd race; serially they're bounded by 2× network latency
- No polling loop, no retry backoff: fail fast on 404, timeout on network hang
- If needed, caller can wrap in `Promise.race([loadConversation(...), timeoutPromise(5000)])` — not the loader's job

---

## Pseudo-Code

```typescript
/**
 * Load a Conversation, its parent Task (if any), and the Project context.
 *
 * RETURNS: Conversation entity with dataContext updated.
 * THROWS:  ConversationLoadError('not_found') if conversation doesn't exist.
 *
 * Best-effort cascade:
 *  - Task is silent-optional (404 continues)
 *  - Project is silent-optional (falls back via null)
 *  - Project prefetch is best-effort (cache-miss doesn't fail load)
 */
export async function loadConversation(conversationId: string): Promise<Conversation> {
  // Phase 1: Fetch conversation (hard requirement).
  const conv = await dataManager
    .getByTypeId<Conversation>(new TypeId(Conversation.type, conversationId))
    .catch(() => null);
  
  if (!conv) {
    throw new ConversationLoadError('not_found', conversationId);
  }

  // Phase 2: Resolve parent task (silent-optional).
  let task: Task | null = null;
  const taskTypeId = conv.firstContextOfType('task');
  if (taskTypeId) {
    // Task exists in context; try to load it.
    // If not found (404 or network), leave task = null and continue.
    task = await dataManager
      .getByTypeId<Task>(taskTypeId)
      .catch(() => null);
  }
  // If taskTypeId is null OR task fetch failed, task remains null.
  // Either way, we proceed to Project resolution.

  // Phase 3: Resolve project (task.project_id > conv.project_id > null).
  //
  // Precedence:
  //   1. task.project_id (if task loaded successfully)
  //   2. conv.project_id (fallback for task-less convs, receiver-mapped)
  //   3. null (no project context — StatusBar renders red pill)
  const projectId = task?.project_id ?? conv.project_id ?? undefined;

  // Phase 4: Write dataContext (active entity + project context + workdir).
  //
  // Active entity = the conversation itself (mirrors load-project + load-task).
  await dataContext.setActiveEntityTypeId(
    new TypeId(Conversation.type, conversationId)
  );

  if (projectId) {
    // Write project context for StatusBar + footer.
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, projectId)
    );
    
    // Prefetch Project entity into cache so useEntity(Project) on first
    // paint hits immediately (no render blank → re-render flicker).
    // Best-effort: if project is deleted or inaccessible, load fails
    // silently and cache stays empty — StatusBar adapts to null context.
    await dataManager
      .getByTypeId<Project>(new TypeId(Project.type, projectId))
      .catch(() => null);
  } else {
    // Conversation has no mapped project (receiver pre-mapping, or
    // project-scoped conversation that lost its project, or task 404).
    // Explicitly write null so StatusBar knows to show red pill.
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      null
    );
  }

  // Phase 5: Set workdir (from task or nothing).
  if (task?.project_root) {
    dataContext.setWorkdir(task.project_root);
  }
  // Note: conv.project_root is not a field; only task carries it.

  return conv;
}

/**
 * Route-level loader for /dock/conversation/<id>[/message/<id>].
 *
 * Handles URL parsing and error recovery. Doesn't throw on not-found
 * — lets the component render its own "conversation not found" state.
 */
export async function loadConversationRoute(
  pointer: string | undefined
): Promise<void> {
  if (!pointer) {
    // No ID in URL — component renders empty state.
    return;
  }

  // Parse pointer (ignore /message/<id> tail — that's view state).
  const { conversationId } = DockPointer.parseConversationPointer(pointer);
  if (!conversationId) return;

  try {
    await loadConversation(conversationId);
  } catch (e) {
    // Don't throw — component shows "not found" gracefully.
    if (!(e instanceof ConversationLoadError)) {
      // Untyped error (network, bug, etc.) — re-throw so ErrorBoundary catches.
      throw e;
    }
    // ConversationLoadError is expected (not_found); silently continue.
  }
}
```

---

## Edge Cases That Break the Pattern

### 1. **Task context stale after conversation loads**
**Scenario:** Conversation loaded, then task deleted before component mounts.
**Impact:** `useEntity(Task, taskTypeId)` returns null; component adapts.
**Why safe:** Task is optional context; conversation renders identically without it.

### 2. **Project deleted between task load and project prefetch**
**Scenario:** `task.project_id` resolves at load time; by prefetch, project is gone.
**Impact:** Prefetch `.catch(() => null)` silently continues; StatusBar adapts to null project.
**Why safe:** Prefetch is cache-optimization, not critical path. Missing cache doesn't fail the page.

### 3. **Conversation moved to different project at runtime**
**Scenario:** User sets `conv.project_id` after load; loader sees old value.
**Impact:** Page renders stale project context until nav refresh.
**Why acceptable:** `conv.project_id` write is rare (only ProjectMappingGate does it); page is not designed for reactive project switches mid-view.
**Recovery:** URL navigation or Revalidator trigger refresh.

### 4. **Task context link removed (explicit remove_context_entity)**
**Scenario:** `conv.firstContextOfType('task')` was truthy at load; later removed via action.
**Impact:** Conversation view doesn't refresh; task chip vanishes only on next nav.
**Why acceptable:** Context removal is admin/debugging action, not user-facing UX.

### 5. **Receiver hasn't mapped project yet (remote_project_id set, project_id null)**
**Scenario:** `conv.remote_project_id` = "abc", `conv.project_id` = null (pre-mapping).
**Impact:** Loader sets project context to null; StatusBar shows red "Select Project" pill.
**Why correct:** ProjectMappingGate dialog will pop and let user map; loader doesn't assume a mapping.

### 6. **Hub-received conversation with no local task equivalent**
**Scenario:** Sender's task "foo" has id 123; receiver's system has never created a task with that id.
**Impact:** `firstContextOfType('task')` contains taskTypeId("task", "123"); fetch fails; task = null.
**Why safe:** Conversation is still fully usable; just missing sender's task context chip.

### 7. **Parallel nav to different conversation while load in flight**
**Scenario:** User clicks /dock/conversation/A; before A loads, clicks /dock/conversation/B.
**Impact:** React Router cancels A's loader; B's loader runs. A's writes to dataContext are overwritten by B.
**Why safe:** dataContext.setActiveEntityTypeId overwrites serially; B wins (URL-first principle).

### 8. **Task exists but has no project_id; conv has project_id**
**Scenario:** `task.project_id` = null, `conv.project_id` = "xyz".
**Impact:** `const projectId = null ?? "xyz"` → projectId = "xyz"; project resolves correctly.
**Why safe:** Null coalescing is the intended fallback mechanism.

---

## Recommendations

### Cascade Strategy: **Lazy + Aggressive Prefetch**

**Lazy fetch:** Task is optional; fetch only if `firstContextOfType('task')` is truthy. ✓ Implemented.

**Aggressive prefetch:** Load Project into cache eagerly (`.catch(() => null)`) so StatusBar + context-aware components hit immediately. ✓ Implemented.

**Why not fully aggressive:** Don't pre-warm task entity — it's optional context, and cold-load prefetch would add latency when task doesn't exist (50% of cases: project-scoped convs, hub-direct convs).

### Error Handling: **Hard-Fail Conversation, Soft-Fail Context**

- **Conversation 404** → Hard fail (`ConversationLoadError`) → route catches, component shows in-tab not-found view
- **Task 404** → Silent continue (task = null) → component renders without task chip
- **Project 404** → Soft continue (project = null) → StatusBar shows red "Select Project" pill

### Testing Strategy

1. **Unit tests** (`load-conversation.test.ts`):
   - Conversation exists, task exists, project exists → all three resolved
   - Conversation exists, task missing, project in conv → project resolves from conv
   - Conversation exists, no task context, no conv project → projectId = null ✓
   - Conversation 404 → throws ConversationLoadError('not_found')

2. **Integration tests** (route-level):
   - `/dock/conversation/A` with task context → task chip appears
   - `/dock/conversation/B` without task → no task chip
   - `/dock/tasks/T/conversation/C` → task active, conversation warm-loaded

3. **Manual E2E**:
   - Delete task while on /dock/conversation/X → no visual change
   - Delete project while on /dock/conversation/X → red pill appears (ProjectMappingGate pops)
   - Hub-received conversation → project mapping gate flows correctly

---

## API Contract

### Input
- `conversationId: string` — UUID of the Conversation entity

### Output
- `Promise<Conversation>` — entity with id, project_id, shared_context_entities populated

### Side Effects (dataContext writes)
- `CurrentActiveEntityTypeId` → Conversation TypeId
- `CurrentProjectTypeId` → Project TypeId (or null)
- `workdir` → task.project_root (if task loaded) or unchanged

### Errors
- `ConversationLoadError('not_found', conversationId)` — conversation entity not found or inaccessible

### No Errors (silent continue)
- Task 404 / inaccessible → task = null
- Project 404 / inaccessible → project = null
- Project prefetch 404 → cache miss (non-fatal)

---

## File Paths

**Frontend:**
- `/Users/shlom/Documents/dev/flowpad-oss/ui/src/routes/loaders/load-conversation.ts` — current stub + full implementation
- `/Users/shlom/Documents/dev/flowpad-oss/ui/src/routes/loaders/main-loader.ts` — entry point (no change needed)
- `/Users/shlom/Documents/dev/flowpad-oss/ui/src/routes/loaders/load-project.ts` — precedent (lines 114–120 show embedded conversation load)
- `/Users/shlom/Documents/dev/flowpad-oss/ui/src/routes/loaders/load-tasks.ts` — precedent (lines 125–132 show conversation cascade)

**Backend:**
- `/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/builtin/conversation.py` — Conversation entity (no change; already carries shared_context_entities via base Entity)
- `/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/builtin/task.py` — Task entity (no change; project_id projected from base)
- `/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/core/entity/entity_model.py` — base Entity (first_context_of_type, project_id) — no change

**Tests:**
- `/Users/shlom/Documents/dev/flowpad-oss/ui/tests/unit/load-conversation.test.ts` — new unit tests
- `/Users/shlom/Documents/dev/flowpad-oss/tests/unit/test_load_conversation_*.py` — optional backend validation

---

## Summary

**Answer to original questions:**

1. **Series or parallel?** Series (task → project), only when task exists.
2. **Fail entirely or conversation-only?** Conversation-only; silent-fail on task 404.
3. **Detect task/project how?** Via `conv.firstContextOfType('task')` and field chain `task.project_id ?? conv.project_id`.
4. **Refresh if cached?** No; cache-first, no refresh.
5. **Implicit or explicit?** Implicit in primitive; explicit control at route level (two-tier split).
6. **Timeout strategy?** None; inherit global network timeout (no loader-specific timeout).

**Pattern:** Lazy + aggressive prefetch; hard-fail conversation, soft-fail context.
