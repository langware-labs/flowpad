import { dataManager, Skill, systemTools } from '@sdk';
import { useDockNavigation } from '@src/navigation';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications/notify';
import { useCallback, useRef, useState } from 'react';
import { basename } from '@src/components/asset-manager/asset-row-helpers';

/**
 * "Open this skill in its editor", shared by every surface that shows a skill
 * chip — the meta-injection chip and the dense tool row. Resolution is lazy:
 * the chat only ever has the skill's folder path, so the entity is discovered
 * on click rather than eagerly for every chip in the transcript.
 */
export function useOpenSkill() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  // The in-flight guard is a ref, not the state: keeping it out of the deps
  // means `openSkill` holds one identity for the hook's life instead of
  // changing twice per click and defeating every consumer's memoization.
  const inFlight = useRef(false);
  const [opening, setOpening] = useState(false);

  const openSkill = useCallback(
    async (skillDir: string): Promise<boolean> => {
      if (!skillDir || inFlight.current) return false;
      const skillName = basename(skillDir) || skillDir;
      inFlight.current = true;
      setOpening(true);
      try {
        const row = await systemTools.discoverByPath(Skill.type, skillDir);
        if (!row) {
          notify.error({ title: t`Skill not found`, message: skillName });
          return false;
        }
        const rowT = row as Record<string, unknown> & { type?: string };
        if (!rowT.type) rowT.type = Skill.type;
        const skill = dataManager.updateEntityFromJson<Skill>(rowT as never);
        if (!skill) return false;
        navigation.openDock(skill.editorDockPointer);
        return true;
      } catch (err) {
        notify.error({
          title: t`Could not open skill`,
          message: err instanceof Error ? err.message : String(err),
        });
        return false;
      } finally {
        inFlight.current = false;
        setOpening(false);
      }
    },
    [navigation, t],
  );

  return { openSkill, opening };
}
