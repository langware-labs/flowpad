/**
 * Edits to an lw block's YAML, made from its card.
 *
 * Like `interface-edit.ts`, an edit goes through `yaml`'s Document API rather
 * than regenerating the block: only the edited value changes, and the author's
 * comments, key order and quoting of everything else survive.
 */

import { isScalar, parseDocument, Scalar } from 'yaml';

/** Replace one statement's sentence. */
export interface LwEdit {
  /** Index of the statement in the block's `statements` list. */
  statement: number;
  text: string;
}

/**
 * Apply `edit` to the block's source.
 *
 * A source that does not parse, or a statement that is no longer there (the
 * card may be one render behind the document), returns the source unchanged:
 * doing nothing is better than corrupting the block.
 */
export function applyLwEdit(source: string, edit: LwEdit): string {
  const doc = parseDocument(source);
  if (doc.errors.length) return source;
  const node = doc.getIn(['statements', edit.statement, 'text'], true);
  if (!isScalar(node) || typeof node.value !== 'string') return source;
  const wasBlock = node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
  node.value = edit.text;
  // Several lines are written as they were typed, one under the other (`|-`), not folded into a
  // quoted string; a sentence back on one line leaves the block form again.
  if (edit.text.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
  else if (wasBlock) node.type = Scalar.PLAIN;
  // `lineWidth: 0`: a sentence is written on one line, exactly as typed, never folded.
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}
