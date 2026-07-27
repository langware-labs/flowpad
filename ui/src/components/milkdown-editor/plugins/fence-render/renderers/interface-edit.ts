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
  | { kind: 'property-name'; property: string; value: string }
  | { kind: 'property-type'; property: string; value: string }
  | { kind: 'property-optional'; property: string; optional: boolean }
  | { kind: 'method-name'; method: string; value: string }
  | { kind: 'method-signature'; method: string; value: string }
  | { kind: 'error'; index: number; value: string };

type MemberCollection = 'params' | 'properties' | 'methods';

function memberMap(doc: Document, collection: MemberCollection): YAMLMap | null {
  const members = doc.getIn([collection], true);
  return isMap(members) ? members : null;
}

/** The key/value pair for a member, so we can edit the key node itself. */
function memberPair(doc: Document, collection: MemberCollection, name: string) {
  const map = memberMap(doc, collection);
  if (!map) return null;
  return map.items.find((item) => isScalar(item.key) && String(item.key.value) === name) ?? null;
}

/**
 * A param is either `title: string` or an object with `type:`. Returns the path
 * to whichever scalar actually holds the type.
 */
function valuePath(
  doc: Document,
  collection: MemberCollection,
  name: string,
  objectKey: 'type' | 'signature',
): (string | number)[] | null {
  const pair = memberPair(doc, collection, name);
  if (!pair) return null;
  if (isMap(pair.value)) return [collection, name, objectKey];
  if (isScalar(pair.value)) return [collection, name];
  return null;
}

function currentValue(
  doc: Document,
  collection: MemberCollection,
  name: string,
  objectKey: 'type' | 'signature',
): string {
  const path = valuePath(doc, collection, name, objectKey);
  if (!path) return '';
  const node = doc.getIn(path);
  // Member values are always YAML scalars; anything else means a malformed
  // block, and an empty string leaves the caller writing a plain value.
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
      const pair = memberPair(doc, 'params', edit.param);
      if (!pair || !isScalar(pair.key)) return source;
      // Renaming through the key node keeps the pair — and therefore its value,
      // its position among siblings, and any trailing comment — intact.
      // `doc.set`/`delete` would drop it to the end and lose the comment.
      pair.key.value = edit.value;
      break;
    }

    case 'param-type': {
      const path = valuePath(doc, 'params', edit.param, 'type');
      if (!path) return source;
      // Editing the type must not silently clear the optional marker.
      const { optional } = splitOptional(currentValue(doc, 'params', edit.param, 'type'));
      const next = splitOptional(edit.value).type;
      doc.setIn(path, optional ? `${next}${OPTIONAL_SUFFIX}` : next);
      break;
    }

    case 'param-optional': {
      const path = valuePath(doc, 'params', edit.param, 'type');
      if (!path) return source;
      const { type } = splitOptional(currentValue(doc, 'params', edit.param, 'type'));
      doc.setIn(path, edit.optional ? `${type}${OPTIONAL_SUFFIX}` : type);
      break;
    }

    case 'property-name': {
      const pair = memberPair(doc, 'properties', edit.property);
      if (!pair || !isScalar(pair.key)) return source;
      pair.key.value = edit.value;
      break;
    }

    case 'property-type': {
      const path = valuePath(doc, 'properties', edit.property, 'type');
      if (!path) return source;
      const { optional } = splitOptional(currentValue(doc, 'properties', edit.property, 'type'));
      const next = splitOptional(edit.value).type;
      doc.setIn(path, optional ? `${next}${OPTIONAL_SUFFIX}` : next);
      break;
    }

    case 'property-optional': {
      const path = valuePath(doc, 'properties', edit.property, 'type');
      if (!path) return source;
      const { type } = splitOptional(currentValue(doc, 'properties', edit.property, 'type'));
      doc.setIn(path, edit.optional ? `${type}${OPTIONAL_SUFFIX}` : type);
      break;
    }

    case 'method-name': {
      const pair = memberPair(doc, 'methods', edit.method);
      if (!pair || !isScalar(pair.key)) return source;
      pair.key.value = edit.value;
      break;
    }

    case 'method-signature': {
      const path = valuePath(doc, 'methods', edit.method, 'signature');
      if (!path) return source;
      doc.setIn(path, edit.value);
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
