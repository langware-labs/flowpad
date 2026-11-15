/**
 * One row of an entity's context, as `GET .../context-relations` returns it
 * (the backend's `ContextRelationSpec`): a peer entity and which way the
 * context runs.
 */
export type ContextVia = 'static' | 'dynamic' | 'user';

export interface ContextRelation {
  /** `out` — this entity holds the peer; `in` — the peer holds it; `both`. */
  direction: 'in' | 'out' | 'both';
  /** The peer as `<type>-<id>`, and its type on its own. */
  typeid: string;
  type: string;
  name: string;
  /** How it is held: `shared` / `private` / `target` (comma-joined when several). */
  kind: string;
  /** The entry's role (`session`, `plan`), `''` when none. */
  role: string;
  /** How the entries came to be: `static` (structure), `dynamic` (linked by the system), `user` (a person's action). */
  via: ContextVia[];
  /** ISO time the entry was made, `''` when unknown. */
  time: string;
}
