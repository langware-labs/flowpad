/** Kind definitions (`GET /api/v1/kinds/<kind>`) and the shape grammar every viewer reads. */
import apiClient from '../client';
import { DATASET_FIELD_KINDS } from '../entities/dataset';
import type { CheckDetail } from '../entities/dataset';
import { isValidUUIDv4 } from '../models/TypeId';
import type { KindForm, Shape } from './contract';

/** The backend's reserved primitives: the ones a person types, plus `binary` (bytes, never typed). */
export const PRIMITIVES: ReadonlySet<string> = new Set([...DATASET_FIELD_KINDS, 'binary', 'date']);

const kindCache = new Map<string, Promise<KindForm | null>>();

/** A registered kind's definition, or null for a primitive / enum / unknown name. "Not registered"
 *  (a 404) is an answer and is remembered; any other failure is THROWN and not remembered: an outage
 *  must not read as "no schema registered" (the caller would tell the user to re-index). */
export function kindForm(kind: string): Promise<KindForm | null> {
  if (!kind || kind.startsWith('enum:') || PRIMITIVES.has(kind)) return Promise.resolve(null);
  if (!kindCache.has(kind)) {
    kindCache.set(
      kind,
      apiClient.get<KindForm>(`/api/v1/kinds/${encodeURIComponent(kind)}`).catch((error) => {
        if (error?.response?.status === 404) return null;
        kindCache.delete(kind);
        throw error;
      }),
    );
  }
  return kindCache.get(kind)!;
}

/** What is wrong with `value` as a value of `kind` — `ok` with no errors when it fits. Writes
 *  nothing. A kind nobody registered is a 404 (rejected), never "fits": the backend would otherwise
 *  read an unknown name as "anything". Without `projectId` it checks the SHAPE only
 *  (`links_checked: false`); with it, the value's references and its kind's rules across rows too —
 *  what a row write checks. */
export async function checkKind(
  kind: string,
  value: unknown,
  options: { projectId?: string } = {},
): Promise<{ kind: string; ok: boolean; errors: string[]; details: CheckDetail[]; links_checked: boolean }> {
  return apiClient.post(`/api/v1/kinds/${encodeURIComponent(kind)}/check`, { value }, {
    params: options.projectId ? { project: options.projectId } : {},
  });
}

/** The full name of the kind a schema of the project defines as `name` (`gtm.icp` →
 *  `--gtm_studio--.gtm.icp`) — 404 (thrown) when it defines none. */
export async function resolveKind(name: string, projectId: string): Promise<string> {
  const { kind } = await apiClient.get<{ kind: string }>(`/api/v1/kinds/${encodeURIComponent(name)}/resolve`, {
    params: { project: projectId },
  });
  return kind;
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

/** The closed set an `enum:a|b` shape (`?enum:…` too) allows, or null for any other shape — read
 *  the grammar here, never re-split it in a view. */
export function enumValues(shape: Shape): string[] | null {
  const { base } = unwrap(shape);
  return typeof base === 'string' && base.startsWith('enum:') ? base.slice('enum:'.length).split('|') : null;
}

/** The row kinds a link field may point at: `crm.company` → `['crm.company']`, `a|b` → both, a list
 *  `[crm.company]` → its element's — or null when the shape names no kind (a primitive, an enum, an
 *  object). Whether a kind is a ROW kind (one a dataset holds) is `Dataset.forKind`'s answer. */
export function linkTargets(shape: Shape): string[] | null {
  const { base } = unwrap(shape);
  const one = Array.isArray(base) ? (base.length === 1 ? unwrap(base[0]).base : null) : base;
  if (typeof one !== 'string' || !namedKind(one)) return null;
  return one.split('|');
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
