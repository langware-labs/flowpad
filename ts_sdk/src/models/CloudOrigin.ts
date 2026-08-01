/**
 * CloudOrigin — where the cloud record a local row caches actually lives.
 * Twin of `flow_sdk/builtin/cloud_origin.py`.
 *
 * `kind` and `provider` are different axes and both matter. `kind` is the
 * CHANNEL a human names (gmail, slack, jira) — the badge axis and half of the
 * thread key. `provider` is the TRANSPORT that carried it, which is literally
 * `"agent"` for the harness-backed Gmail source. One channel can have several
 * transports, and they must resolve to the same thread.
 */
export interface ICloudOrigin {
  /** Channel: gmail | slack | jira | notion. Drives the message badge. */
  kind: string;
  /** Ingest driver key: agent | gmail_api | slack_api. */
  provider: string;
  /** The configured DataSource this arrived through. */
  data_source_id: string;
  /** The local cache row, 1:1. */
  source_item_id: string;
  /** The provider's own id for the record. */
  external_id: string;
  /** Permalink into the origin system — what "Open in Gmail" opens. */
  url: string;
}

/** Whether an origin can be opened in a browser. */
export function isAddressable(origin: ICloudOrigin | null | undefined): boolean {
  return !!origin?.url;
}
