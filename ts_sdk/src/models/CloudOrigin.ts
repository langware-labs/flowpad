/**
 * CloudOrigin — the identity of a remote record: `(kind, namespace, key)`.
 * Twin of `flow_sdk/sources/values/origin.py`.
 *
 * `kind` is the system a human names (gmail, slack, jira) — the badge axis. `namespace`
 * is the account/collection scope within it (`<workspace>/<channel>`, `<address>`), and
 * `key` the record within that scope. Two origins with the same triple are the same
 * record whatever transport carried them, which is what keeps a thread ingested through
 * the harness today and the API tomorrow ONE thread. `url` is browser metadata only.
 */
export interface ICloudOrigin {
  /** System: gmail | slack | jira | local. Drives the message badge. */
  kind: string;
  /** Account and collection scope within the kind. */
  namespace: string;
  /** The record within that scope. */
  key: string;
  /** Permalink into the origin system — what "Open in Gmail" opens; null when there is none. */
  url: string | null;
}

/**
 * The local row pointers behind a cached cloud record. Carried by a PRIVATE
 * field, so it is ABSENT on any message received from another machine — these
 * are row ids in one instance's database and resolve nowhere else.
 */
export interface ICloudOriginLocal {
  /** The configured DataSource this arrived through. */
  data_source_id: string;
  /** The local cache row, 1:1. */
  source_item_id: string;
}

/** Whether an origin can be opened in a browser. */
export function isAddressable(origin: ICloudOrigin | null | undefined): boolean {
  return !!origin?.url;
}
