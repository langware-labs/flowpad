/**
 * The row fields shared by every search result, whichever endpoint produced it.
 *
 * There are two search endpoints and they are genuinely different — `/search`
 * (see `use-asset-search`) and `/graph/compute_node/@local/fs-records/search`
 * (see `use-record-search`). Each hook therefore keeps its own `SearchResult`
 * with the fields only its endpoint returns; those are NOT one payload declared
 * twice and must not be merged.
 *
 * What was duplicated is the part below: eight identical required fields, and
 * the handful of optional extras one side or the other adds. Because both hooks
 * declared that overlap separately, the two `SearchResult`s were structurally
 * incompatible, and the shared CONSUMERS — `AssetDataTable`, which renders
 * either, and `navigateToResult`, which routes either — each had to pick one
 * hook's type and then reject rows from the other.
 *
 * So the rule is: a component that renders or routes a search row types against
 * `SearchRow`, not against either hook's `SearchResult`. Reach for the hook's
 * own type only when you need a field unique to that endpoint.
 */
export interface SearchRow {
  record_id: string;
  record_type: string;
  name: string;
  status: string;
  scope: string;
  asset_ref: string;
  created_at: string;
  modified_at: string;

  // ── Present on `/search` (asset) rows ──────────────────────────────────────
  uname?: string;
  title?: string;
  description?: string;
  file_path?: string;
  work_dir?: string;
  project_id?: string;
  project_name?: string;

  // ── Present on fs-records rows ─────────────────────────────────────────────
  session_id?: string;
}
