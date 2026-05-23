import { apiClient, TypeId } from '@sdk';

/**
 * Pre-warm helper for context-entity chip clicks.
 *
 * Context chips can reference entities whose DB row isn't materialized yet —
 * a Plan that Claude wrote but the indexer hasn't walked, a Markdown the
 * cross-link recorded by typeid before the markdown indexer touched it, etc.
 * The sidecar `data.path` harvested at detection time lets the backend
 * single-file-rehydrate the row via `?hint_path=...`; this helper fires that
 * GET before navigation so the dock view finds a populated row when it loads.
 *
 * Single source of truth for the pre-warm — `EntityContextPanel`,
 * `ConversationContextPanel`, and `ContextEntityChip` (used by
 * `FlowMessageBubble`, `TaskChips`, `ConversationEntityChips`) all call this.
 *
 * Best-effort: a 404 or network error is swallowed so navigation still
 * proceeds. The dock view's `useEntity` will surface a real failure
 * separately if the self-heal couldn't recover (file moved, type not
 * registered in the backend dispatcher, etc.).
 */
export function useChipPrewarm() {
  return async function prewarm(typeId: TypeId, hintPath: string | undefined): Promise<void> {
    if (!hintPath) return;
    try {
      const qs = new URLSearchParams({ hint_path: hintPath }).toString();
      await apiClient.get(`/graph/${typeId.type}/${typeId.id}?${qs}`);
    } catch {
      // Fall through — the dock view surfaces real failures.
    }
  };
}
