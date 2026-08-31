import { useCallback, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Skill } from '@sdk';
import { notify } from '@src/notifications';
import type { AgentDocument } from './useAgentDocument';

export interface SkillsWiring {
  /** Serialized TypeIds currently declared in the document. */
  declared: Set<string>;
  /** The one row whose write is in flight, or null. */
  pendingId: string | null;
  /** Attach/detach a skill. No-op until the document is readable. */
  toggle: (skill: Skill, next: boolean) => Promise<void>;
}

/**
 * Read/write of the agent's declared `skills`, against `agent.md` itself.
 *
 * **The stored value is the serialized TypeId (`skill-<uuid>`), never the skill
 * name.** That is the form on disk, and the Python model types the field as
 * `list[TypeId]` whose constructor splits on `-` — a bare name raises inside
 * validation and breaks indexing of the whole record.
 *
 * State is document-derived, not optimistic: a row reflects what the file says
 * and only the in-flight row is disabled. A local mirror is how a failed write
 * becomes a lie on screen.
 */
export function useAgentSkillsWiring(doc: AgentDocument): SkillsWiring {
  const { t } = useLingui();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const declaredList = doc.list('skills');
  // Memoized on the joined ids: consumers use this in their own `useMemo` deps,
  // and a fresh Set each render would defeat every one of them.
  const declaredKey = declaredList.join(' ');
  const declared = useMemo(() => new Set(declaredKey ? declaredKey.split(' ') : []), [declaredKey]);

  const toggle = useCallback(
    async (skill: Skill, next: boolean) => {
      if (!doc.ready) return;
      const id = skill.typeId?.toString();
      if (!id) return;

      setPendingId(id);
      try {
        const current = doc.list('skills');
        const updated = next ? [...current, id] : current.filter((s) => s !== id);
        await doc.commit({ skills: updated });
      } catch (err) {
        notify.error({
          title: t`Couldn't update skills`,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setPendingId(null);
      }
    },
    [doc, t],
  );

  return { declared, pendingId, toggle };
}
