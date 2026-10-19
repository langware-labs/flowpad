/**
 * Tab identity for a vibe workspace's ACTIVE DISPLAY.
 *
 * The active display is ONE row per workspace whose TARGET changes on every
 * `flow show`. That inverts the usual rule — normally the pointer is identity and
 * the host is presentation context — so these tests pin the inversion and, just as
 * importantly, its boundaries: a durable child the USER opened must keep ordinary
 * identity, and a flagged dock with no host must never mint a hostless row.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVE_DISPLAY_PARAM, DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJ = 'dd682350-c185-52c9-a92b-d0667141b069';
const ASSET_A = 'a684848a-af63-4c8a-988e-37a2c01b20b5';
const ASSET_B = 'b1119f21-3c0e-4f77-8a1d-2f5c7d9e0011';
const HOST = 'agentic_process-abc1e873-1ae2-4c55-9242-6b4ddea51420';
const HOST_2 = 'agentic_process-11112222-3333-4444-5555-666677778888';

/** A project-rebased asset editor dock — the shape `flow show <file>` produces. */
const target = (assetId: string): DockPointer =>
  new DockPointer(ViewType.PROJECT, `${PROJ}/editor/markdown/typeid/markdown-${assetId}`);

const activeDisplay = (assetId: string, host = HOST): DockPointer =>
  target(assetId).withHost(host).withActiveDisplay(true);

describe('active-display tab identity', () => {
  it('keys on the HOST, not the target, so a new show re-points one row', () => {
    // The whole mechanism in one assertion: two different documents, one identity.
    expect(activeDisplay(ASSET_A).tabHash).toBe(`workspaceActive|${HOST}`);
    expect(activeDisplay(ASSET_B).tabHash).toBe(activeDisplay(ASSET_A).tabHash);
  });

  it('gives each workspace its own active display', () => {
    expect(activeDisplay(ASSET_A, HOST_2).tabHash).toBe(`workspaceActive|${HOST_2}`);
    expect(activeDisplay(ASSET_A, HOST_2).tabHash).not.toBe(activeDisplay(ASSET_A).tabHash);
  });

  it('never spells the hash with "display" — the legacy reaper prefilters on that substring', () => {
    // `_reap_orphans` in flow_sdk/builtin/tab.py does `"display" in pointer` before
    // parsing. A hash containing it would pay a JSON parse per tab per list read and
    // sit one comparison from a sweep it has nothing to do with.
    const json = activeDisplay(ASSET_A).toJSON();
    expect(json).not.toContain('display|');
    expect(JSON.parse(json!).tabHash).not.toContain('display');
  });

  it('falls through to ordinary identity when the flag carries no host', () => {
    // The guard that stops a hand-edited URL, or the standard-mode strip, from
    // minting a hostless `workspaceActive|` row.
    const hostless = target(ASSET_A).withActiveDisplay(true);
    expect(hostless.isActiveDisplay).toBe(true);
    expect(hostless.hostProcessId).toBeNull();
    expect(hostless.tabHash).toBe(target(ASSET_A).tabHash);
  });

  it('leaves a user-opened child of the same workspace durable and distinct', () => {
    // Promotion ("open in tab") is exactly this dock: same target, same host, no flag.
    const durable = target(ASSET_A).withHost(HOST);
    expect(durable.tabHash).toBe(`project|${PROJ}/editor/markdown/typeid/markdown-${ASSET_A}`);
    expect(durable.tabHash).not.toBe(activeDisplay(ASSET_A).tabHash);
  });

  it('is unaffected by the options that ride alongside it', () => {
    const base = activeDisplay(ASSET_A);
    expect(base.withViewMode('vibe' as never).tabHash).toBe(base.tabHash);
    expect(base.withJourney('j-1').tabHash).toBe(base.tabHash);
  });

  it('persists the REAL target beside the constant hash', () => {
    // The asymmetry the backend relies on: it reconciles by the hash (finds the same
    // row) and rewrites the stored pointer in place (re-points it).
    const parsed = JSON.parse(activeDisplay(ASSET_B).toJSON()!);
    expect(parsed.viewType).toBe(ViewType.PROJECT);
    expect(parsed.pointer).toBe(`${PROJ}/editor/markdown/typeid/markdown-${ASSET_B}`);
    expect(parsed.tabHash).toBe(`workspaceActive|${HOST}`);
    expect(parsed.options).toEqual({ [ACTIVE_DISPLAY_PARAM]: '1' });
    // Read by the backend's adoptable-child check, which parses the RAW pointer and
    // would otherwise eject an assets-shaped active display from the child strip.
    expect(parsed.workspaceContent).toBe(true);
    // The host appears ONCE, as identity inside the hash — never as a carried option
    // or inside the pointer. `hostToCarry` re-stamps the option from the live URL on a
    // chip click, which is what keeps a click inside workspace A in workspace A rather
    // than teleporting the user into whichever workspace last showed the document.
    expect(parsed.options[Object.keys(parsed.options)[0]]).toBe('1');
    expect(parsed.options).not.toHaveProperty('host');
    expect(parsed.pointer).not.toContain(HOST);
  });

  it('round-trips through fromJSON with chip identity intact', () => {
    // fromJSON restores the flag but not the host, so the rebuilt dock hashes as the
    // plain target. That is correct: `Tab.getKey()` reads the STORED tabHash field,
    // and clicking the chip re-acquires the host from the live URL.
    const restored = DockPointer.fromJSON(activeDisplay(ASSET_A).toJSON()!);
    expect(restored).not.toBeNull();
    expect(restored!.isActiveDisplay).toBe(true);
    expect(restored!.hostProcessId).toBeNull();
    expect(restored!.tabHash).toBe(target(ASSET_A).tabHash);
  });

  it('survives the URL round trip', () => {
    const url = activeDisplay(ASSET_A).toUrl('/');
    expect(url).toContain(`/process/${HOST}/display/`);
    expect(url).toContain(`${ACTIVE_DISPLAY_PARAM}=1`);
    expect(DockPointer.fromUrl(url).tabHash).toBe(`workspaceActive|${HOST}`);
  });

  it('clears cleanly, leaving no empty param behind', () => {
    const off = activeDisplay(ASSET_A).withActiveDisplay(false);
    expect(off.isActiveDisplay).toBe(false);
    expect(off.toUrl('/')).not.toContain(ACTIVE_DISPLAY_PARAM);
    expect(off.tabHash).toBe(target(ASSET_A).tabHash);
  });
});
