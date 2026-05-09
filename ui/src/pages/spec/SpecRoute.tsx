import { SpecEditor } from '@src/components/spec-editor/SpecEditor';

/**
 * Top-level renderer for the `/dock/spec/<id>` route. Defers entirely to
 * ``SpecEditor`` (spec-entity mode), which loads the Spec record from the
 * dock pointer and renders its body in the standard Milkdown editor with
 * the side panel shell.
 */
export function SpecRoute() {
  return <SpecEditor />;
}
