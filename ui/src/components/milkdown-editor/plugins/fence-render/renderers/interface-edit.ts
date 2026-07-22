/**
 * In-place edits to an ```interface block's YAML.
 *
 * Every edit goes through `yaml`'s Document (AST) API rather than
 * parse → mutate object → stringify. That difference is the whole point: a
 * round-trip through the plain API silently reformats the author's file the
 * first time they touch any field — comments dropped, key order normalised,
 * quoting style changed, blank lines collapsed. Mutating the document in place
 * touches only the scalar being edited and leaves everything else byte-identical.
 *
 * Pure string → string, so the write-back path is unit-testable without a
 * NodeView or an editor.
 */

import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';

import { OPTIONAL_SUFFIX, splitOptional } from './interface-schema';

export type InterfaceEdit =
  | { kind: 'name'; value: string }
  | { kind: 'description'; value: string }
  | { kind: 'returns'; value: string }
  | { kind: 'param-name'; param: string; value: string }
  | { kind: 'param-type'; param: string; value: string }
  | { kind: 'param-optional'; param: string; optional: boolean }
  | { kind: 'error'; index: number; value: string };

function paramsMap(doc: Document): YAMLMap | null {
  const params = doc.getIn(['params'], true);
  return isMap(params) ? params : null;
}

/** The key/value pair for a param, so we can edit the key node itself. */
function paramPair(doc: Document, name: string) {
  const map = paramsMap(doc);
  if (!map) return null;
  return map.items.find((item) => isScalar(item.key) && String(item.key.value) === name) ?? null;
}

/**
 * A param is either `title: string` or an object with `type:`. Returns the path
 * to whichever scalar actually holds the type.
 */
function typePath(doc: Document, name: string): (string | number)[] | null {
  const pair = paramPair(doc, name);
  if (!pair) return null;
  if (isMap(pair.value)) return ['params', name, 'type'];
  if (isScalar(pair.value)) return ['params', name];
  return null;
}

function currentType(doc: Document, name: string): string {
  const path = typePath(doc, name);
  if (!path) return '';
  const node = doc.getIn(path);
  // Types are always YAML scalars; anything else means a malformed block, and
  // an empty string leaves the caller writing a plain type with no marker.
  return typeof node === 'string' ? node : '';
}

/**
 * Apply one edit and return the new YAML source.
 *
 * Unknown targets (a param that no longer exists, an out-of-range error index)
 * return the source unchanged rather than throwing — the card may be a render
 * behind the document after a concurrent edit, and silently doing nothing is
 * better than corrupting the block.
 */
export function applyInterfaceEdit(source: string, edit: InterfaceEdit): string {
  const doc = parseDocument(source);
  if (doc.errors.length) return source;

  switch (edit.kind) {
    case 'name':
    case 'description':
    case 'returns': {
      // Only edit keys the author already has; the card renders no control for
      // an absent field, so an edit for one means we're out of sync.
      if (doc.get(edit.kind) === undefined) return source;
      doc.set(edit.kind, edit.value);
      break;
    }

    case 'param-name': {
      const pair = paramPair(doc, edit.param);
      if (!pair || !isScalar(pair.key)) return source;
      // Renaming through the key node keeps the pair — and therefore its value,
      // its position among siblings, and any trailing comment — intact.
      // `doc.set`/`delete` would drop it to the end and lose the comment.
      pair.key.value = edit.value;
      break;
    }

    case 'param-type': {
      const path = typePath(doc, edit.param);
      if (!path) return source;
      // Editing the type must not silently clear the optional marker.
      const { optional } = splitOptional(currentType(doc, edit.param));
      const next = splitOptional(edit.value).type;
      doc.setIn(path, optional ? `${next}${OPTIONAL_SUFFIX}` : next);
      break;
    }

    case 'param-optional': {
      const path = typePath(doc, edit.param);
      if (!path) return source;
      const { type } = splitOptional(currentType(doc, edit.param));
      doc.setIn(path, edit.optional ? `${type}${OPTIONAL_SUFFIX}` : type);
      break;
    }

    case 'error': {
      const errors = doc.get('errors', true);
      if (!isSeq(errors) || edit.index < 0 || edit.index >= errors.items.length) return source;
      doc.setIn(['errors', edit.index], edit.value);
      break;
    }
  }

  // `flowCollectionPadding: false` keeps `[NotFound, Forbidden]` as written;
  // the default re-emits it as `[ NotFound, Forbidden ]`.
  //
  // KNOWN NORMALIZATION: the serializer does not remember a comment's original
  // column, so `title: string      # required` comes back as
  // `title: string # required`. The comment itself survives — only the padding
  // before it collapses, and only on lines the document is re-emitting. No
  // option controls this.
  return doc.toString({ flowCollectionPadding: false });
}
