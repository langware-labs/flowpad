/**
 * Wiki link edge — mirrors the python `flow_sdk.wiki.types.WikiLink` dataclass.
 *
 * One row per [[...]] occurrence in a source record's body. `target_type` /
 * `target_id` are null when the link is unresolved.
 */
export interface WikiLink {
  id: number | null;
  src_type: string;
  src_id: string;
  raw: string;
  target_type: string | null;
  target_id: string | null;
  line: number;
}
