/**
 * Options for tab navigation
 */
export interface TabOptions {
  pinned?: boolean;
  setActive?: boolean;
  /**
   * Capability kind this tab is being opened FOR (Capabilities view only) —
   * the thing the user was reaching for. Serialized as the `capability` URL
   * option; the view re-probes that kind on arrival. See CAPABILITY_PARAM.
   */
  capabilityKind?: string;
}

/**
 * Options for file navigation
 */
export interface FileOptions {
  line?: number;
  column?: number;
  openInNewTab?: boolean;
}
