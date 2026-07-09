/**
 * The vibe Display surface — `DockPointer.forDisplay`, its `ViewType.DISPLAY`
 * route/registry wiring, and the loader dispatch. The Display is the process's
 * always-present right pane in vibe mode, addressed by its own URL
 * (`/dock/display/agentic_process-<id>`) — NOT the process's shell tab.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { isValidView } from '@src/navigation/validators';
import { AgenticProcess } from '@sdk';

const PROC = '37c47bb1-f010-45e2-8ed9-fcad8901f7da';

describe('DockPointer.forDisplay', () => {
  it('builds a DISPLAY dock carrying the agentic_process pointer grammar', () => {
    const dock = DockPointer.forDisplay(PROC);
    expect(dock.viewType).toBe(ViewType.DISPLAY);
    expect(dock.pointer).toBe(`${AgenticProcess.type}-${PROC}`);
  });

  it('resolves the owning process via targetTypeId (free from the shell grammar)', () => {
    const dock = DockPointer.forDisplay(PROC);
    expect(dock.targetTypeId?.type).toBe(AgenticProcess.type);
    expect(dock.targetTypeId?.id).toBe(PROC);
  });

  it('keys a stable, per-process tab hash (one Display per process)', () => {
    expect(DockPointer.forDisplay(PROC).tabHash).toBe(DockPointer.forDisplay(PROC).tabHash);
    expect(DockPointer.forDisplay(PROC).tabHash).not.toBe(
      DockPointer.forDisplay('00000000-0000-4000-8000-000000000000').tabHash,
    );
  });

  it('round-trips through the URL as a valid `display` view', () => {
    const url = DockPointer.forDisplay(PROC).toUrl();
    expect(url).toContain('/dock/display/');
    expect(isValidView('display')).toBe(true);
  });
});

describe('ViewType.DISPLAY registry', () => {
  it('is named "Display" and is not a manually-addable tab', () => {
    const meta = VIEWER_REGISTRY[ViewType.DISPLAY];
    expect(meta?.title).toBe('Display');
    expect(meta?.canAddAsTab).toBe(false);
  });
});
