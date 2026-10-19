import { editorsFor, TypeId } from '@sdk';
import { DockPointer } from './DockPointer';

/**
 * Where a subject (a dataset, say) opens: the best app that edits it, opened ON it —
 * `/dock/app/<editor>?subject=<typeid>`. The backend ranks the editors (nested › kind › type,
 * `flow_sdk/builtin/faas/editors.py`); null when nothing edits it.
 *
 * One answer for every way in: a record row's click and the address bar's subject crumb.
 */
export async function subjectEditorPointer(subject: string): Promise<DockPointer | null> {
  const [best] = await editorsFor(subject);
  return best ? DockPointer.forAppEntity(new TypeId(best.typeid), { subject }) : null;
}
