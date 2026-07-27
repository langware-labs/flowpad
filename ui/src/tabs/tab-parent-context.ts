/**
 * Tab-parent context — a single "tabs materialized right now are children of
 * THIS tab" slot, consumed at the tab chokepoint (`materializeTab`).
 *
 * Set by a workspace surface (the vibe display) WHILE it is mounted: any tab a
 * navigation materializes during that window — the display's open button, a
 * link inside child content, anything — is minted as a child of the registered
 * display tab (Tab.parent_tab_id). This keeps the grouping generic: no
 * navigation call site knows about "children"; the opener locality lives here.
 *
 * Module-scoped + per-client; never persisted (the durable relation lives on
 * the Tab row). Standard mode never registers, so no accidental children.
 */

let activeParentTabId: string | null = null;

/** Register the tab that new tabs should be parented to (the display tab). Pass
 *  null to clear (workspace unmount). */
export function setActiveTabParent(tabId: string | null): void {
  activeParentTabId = tabId;
}

/** Read the active parent without clearing (chokepoint input). */
export function getActiveTabParent(): string | null {
  return activeParentTabId;
}
