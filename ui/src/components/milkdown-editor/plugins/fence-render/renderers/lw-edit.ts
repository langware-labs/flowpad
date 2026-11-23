/**
 * Edits to an lw block's YAML, made from its card.
 *
 * Like `interface-edit.ts`, an edit goes through `yaml`'s Document API rather
 * than regenerating the block: only the edited value changes, and the author's
 * comments, key order and quoting of everything else survive.
 */

import { isScalar, isSeq, parseDocument, Scalar } from 'yaml';

/** What a statements card can change in its block. */
export type LwEdit =
  /** Replace one statement's sentence. `statement` is its index in the block's `statements` list. */
  | { kind: 'text'; statement: number; text: string }
  /** Add a statement at the end of the list. */
  | { kind: 'add'; text: string }
  /** Remove a statement, with its issues and files. A block keeps at least one. */
  | { kind: 'delete'; statement: number };

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
  const statements = doc.get('statements', true);
  if (!isSeq(statements)) return source;

  if (edit.kind === 'add') {
    // A statement added on the card is the owner's: `stated`.
    statements.add(doc.createNode({ text: edit.text, basis: 'stated' }));
  } else if (edit.kind === 'delete') {
    // An empty list is not a block; the last statement goes with the block (Code tab, `flow tag drop`).
    if (statements.items.length < 2 || !statements.delete(edit.statement)) return source;
  } else {
    const node = statements.getIn([edit.statement, 'text'], true);
    if (!isScalar(node) || typeof node.value !== 'string') return source;
    const wasBlock = node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
    node.value = edit.text;
    // Several lines are written as they were typed, one under the other (`|-`), not folded into a
    // quoted string; a sentence back on one line leaves the block form again.
    if (edit.text.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
    else if (wasBlock) node.type = Scalar.PLAIN;
  }
  // `lineWidth: 0`: a sentence is written on one line, exactly as typed, never folded.
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}
