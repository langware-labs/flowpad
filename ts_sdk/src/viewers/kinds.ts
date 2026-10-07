/** Kind definitions (`GET /api/v1/kinds/<kind>`) and the shape grammar every viewer reads. */
import apiClient from '../client';
import { DATASET_FIELD_KINDS } from '../entities/dataset';
import { isValidUUIDv4 } from '../models/TypeId';
import type { KindForm, Shape } from './contract';

export const PRIMITIVES: ReadonlySet<string> = new Set(DATASET_FIELD_KINDS);

const kindCache = new Map<string, Promise<KindForm | null>>();

/** A registered kind's definition, or null for a primitive / enum / unknown name. "Not registered"
 *  (a 404) is an answer and is remembered; any other failure is not, so it is retried next time. */
export function kindForm(kind: string): Promise<KindForm | null> {
  if (!kind || kind.startsWith('enum:') || PRIMITIVES.has(kind)) return Promise.resolve(null);
  if (!kindCache.has(kind)) {
    kindCache.set(
      kind,
      apiClient.get<KindForm>(`/api/v1/kinds/${encodeURIComponent(kind)}`).catch((error) => {
        if (error?.response?.status !== 404) kindCache.delete(kind);
        return null;
      }),
    );
  }
  return kindCache.get(kind)!;
}

/** `?x` is an optional `x`. */
export function unwrap(shape: Shape): { optional: boolean; base: Shape } {
  return typeof shape === 'string' && shape.startsWith('?')
    ? { optional: true, base: shape.slice(1) }
    : { optional: false, base: shape };
}

/** "Any kind" — what a viewer declares to show everything; never a kind of its own. */
export const ANY_KIND = '*';

/** The registered kind a shape names (`?navigation.here` → `navigation.here`), else null — never
 *  {@link ANY_KIND}, which the backend refuses as a name. */
export function namedKind(shape: Shape): string | null {
  const { base } = unwrap(shape);
  return typeof base === 'string' && base && base !== ANY_KIND && !base.startsWith('enum:') && !PRIMITIVES.has(base)
    ? (parseValueRef(base)?.kind ?? base)
    : null;
}

/** The kind and id a value reference `<kind>.id.<uuid>` names (one stored value of a kind,
 *  `flow_sdk/schema/data_spec/value_ref.py`), or null for anything else. */
export function parseValueRef(text: unknown): { kind: string; id: string } | null {
  if (typeof text !== 'string') return null;
  const at = text.lastIndexOf('.id.');
  const kind = text.slice(0, at);
  const id = text.slice(at + 4);
  return at > 0 && isValidUUIDv4(id) && !kind.split('.').includes('id') ? { kind, id } : null;
}
