/** Kind definitions (`GET /api/v1/kinds/<kind>`) and the shape grammar every viewer reads. */
import apiClient from '../client';
import { DATASET_FIELD_KINDS } from '../entities/dataset';
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

/** The registered kind a shape names (`?navigation.here` → `navigation.here`), else null. */
export function namedKind(shape: Shape): string | null {
  const { base } = unwrap(shape);
  return typeof base === 'string' && base && !base.startsWith('enum:') && !PRIMITIVES.has(base) ? base : null;
}
