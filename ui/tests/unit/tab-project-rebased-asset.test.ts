/**
 * RCA capture: a PROJECT-rebased asset dock must still resolve the inner asset
 * by path and adopt the asset's OWN project on the tab.
 *
 * The bug: opening `/dock/project/<pid>/editor/skill/vfs/<absVfs>` (the form
 * `rebaseAssetsOntoProject` produces) yields a dock with `viewType=PROJECT`.
 * `Tab.getFromDockPointer`'s target-resolution channels (`dock.vfsPath` and
 * `dock.targetTypeId`) both special-case ONLY `viewType=ASSETS`, so for a
 * PROJECT-rebased dock neither fires: the inner asset path is never looked up,
 * the asset's `project_id` (present in the DB) is never read, and the tab is
 * minted project-less (observed: `rca` tab row had project_id=None).
 *
 * Expectation under test: the asset/file/path project ALWAYS wins — it is
 * adopted onto the tab, replacing any project the URL/dock already names.
 *
 * Both tests FAIL before the fix (the tab gets `null`).
 */
import { dataManager, Project, Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SKILL_ID = '55555555-5555-4555-8555-555555555555';
const URL_PID = 'dd682350-c185-52c9-a92b-d0667141b069'; // the project segment in the URL
const ASSET_PID = '66666666-6666-4666-8666-666666666666'; // the skill's OWN project (differs)
const MACHINE_PATH = '/Users/shlom/Documents/dev/flowpad-oss/.claude/skills/rca';

afterEach(() => vi.restoreAllMocks());

/** Capture the project_id Tab.getFromDockPointer posts to new_tab. */
function captureNewTabProjectId(): { value: () => string | null } {
  let captured: string | null = null;
  vi.spyOn(dataManager, 'callAction').mockImplementation(async (info: any) => {
    if (info?.name === 'new_tab') captured = info.bodyParameters?.project_id ?? null;
    return { tabs: [] } as any;
  });
  vi.spyOn(dataManager, 'getTabName').mockReturnValue('rca');
  return { value: () => captured };
}

/** Build the exact URL-#2 dock: an asset editor rebased onto a project shell. */
function projectRebasedSkillDock(projectId: string): DockPointer {
  const assetsDock = DockPointer.forAssetEditor('skill', MACHINE_PATH);
  return DockPointer.rebaseAssetsOntoProject(assetsDock, projectId);
}

describe('Tab.getFromDockPointer — project-rebased asset dock adopts the asset path project', () => {
  it('resolves the inner asset by path and adopts the asset entity project_id', async () => {
    const byPath = vi.spyOn(dataManager, 'getEntityByPath').mockResolvedValue({
      typeId: { type: 'skill', id: SKILL_ID },
      project_id: ASSET_PID,
    } as any);
    const cap = captureNewTabProjectId();

    await Tab.getFromDockPointer(projectRebasedSkillDock(URL_PID));

    // The inner asset path must be recovered from the PROJECT-rebased pointer
    // and looked up by its machine path (== asset_ref).
    expect(byPath).toHaveBeenCalledWith(MACHINE_PATH);
    // …and the asset's own project is what the tab adopts.
    expect(cap.value()).toBe(ASSET_PID);
  });

  it('the asset/path project replaces the project named in the URL segment', async () => {
    // URL says project=URL_PID, but the skill actually belongs to ASSET_PID.
    vi.spyOn(dataManager, 'getEntityByPath').mockResolvedValue({
      typeId: { type: 'skill', id: SKILL_ID },
      project_id: ASSET_PID,
    } as any);
    // Guard: even if the fix recovers project-<id> from the URL, the asset wins.
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({
      typeId: { type: 'project', id: URL_PID },
    } as any);
    const cap = captureNewTabProjectId();

    await Tab.getFromDockPointer(projectRebasedSkillDock(URL_PID));

    expect(cap.value()).toBe(ASSET_PID);
    expect(cap.value()).not.toBe(URL_PID);
  });
});
