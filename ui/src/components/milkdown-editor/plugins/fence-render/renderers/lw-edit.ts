/**
 * Edits to an lw block's YAML, made from its card.
 *
 * Like `interface-edit.ts`, an edit goes through `yaml`'s Document API rather
 * than regenerating the block: only the edited value changes, and the author's
 * comments, key order and quoting of everything else survive.
 */

import { parseDocument } from 'yaml';

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
  const path = ['statements', edit.statement, 'text'];
  if (typeof doc.getIn(path) !== 'string') return source;
  doc.setIn(path, edit.text);
  // `lineWidth: 0`: a sentence is written on one line, exactly as typed, never folded.
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}
