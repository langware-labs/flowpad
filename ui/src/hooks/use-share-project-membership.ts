import { useCallback, useEffect, useRef, useState } from 'react';
import { membershipService, type Membership, type Project } from '@sdk';

export const NO_PROJECT_ROLE = 'none';
const identity = (value: string) => (value.includes('@') ? value.trim().toLowerCase() : value.replace(/^user-/, ''));
export function projectNonMembers(recipients: string[], roster: Membership[]): string[] {
  const known = new Set(roster.flatMap((member) => [member.user_id, member.user_email].filter(Boolean).map(identity)));
  return recipients.filter((recipient) => !known.has(identity(recipient)));
}
type State = {
  key: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  nonMembers: string[];
  roles: string[];
};
/** Suggest membership only after an authoritative roster read. */
export function useShareProjectMembership(project: Project | null, recipients: string[], enabled: boolean) {
  const recipientsKey = JSON.stringify(recipients);
  const key = enabled && project?.remote ? `${project.id}:${recipientsKey}` : '';
  const currentKey = useRef(key);
  currentKey.current = key;
  const revision = useRef(0);
  const invited = useRef(new Set<string>());
  // Successful invitations deduplicate retries only within this open draft.
  // Replace the set so an old in-flight invite cannot repopulate a new draft.
  useEffect(() => {
    invited.current = new Set();
    return () => {
      invited.current = new Set();
    };
  }, [enabled, project?.id]);
  const [state, setState] = useState<State>({ key: '', status: 'idle', error: null, nonMembers: [], roles: [] });
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    if (!key || !project) return;
    setState({ key, status: 'loading', error: null, nonMembers: [], roles: [] });
    try {
      const [roster, roles] = await Promise.all([
        membershipService.fetchMembershipsStrict(project.typeId),
        membershipService.fetchShareRoles(),
      ]);
      if (!roles.length) throw new Error('Could not load project roles.');
      if (request !== revision.current || key !== currentKey.current) return;
      const successful = invited.current;
      const nonMembers = projectNonMembers(JSON.parse(recipientsKey), roster).filter(
        (recipient) => !successful.has(identity(recipient)),
      );
      setState({ key, status: 'ready', error: null, nonMembers, roles });
    } catch (error) {
      if (request !== revision.current || key !== currentKey.current) return;
      setState({
        key,
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not load project members.',
        nonMembers: [],
        roles: [],
      });
    }
  }, [key, project, recipientsKey]);
  useEffect(() => {
    void refresh();
    return () => {
      revision.current += 1;
    };
  }, [refresh]);
  const invite = useCallback(
    async (choices: Record<string, string>) => {
      if (!key || !project) return;
      if (state.key !== key || state.status !== 'ready') throw new Error('Project membership has not been confirmed.');
      const successful = invited.current;
      const selected = state.nonMembers.filter(
        (recipient) =>
          choices[recipient] && choices[recipient] !== NO_PROJECT_ROLE && !successful.has(identity(recipient)),
      );
      if (!selected.length) return;
      for (const recipient of selected)
        if (!state.roles.includes(choices[recipient])) throw new Error('The selected project role is unavailable.');
      const result = await project.invite(selected.map((idOrEmail) => ({ idOrEmail, role: choices[idOrEmail] })));
      for (const recipient of [...result.invited, ...result.skipped]) {
        if (recipient.email) successful.add(identity(recipient.email));
        if (recipient.user_id) successful.add(identity(recipient.user_id));
      }
      await refresh();
      if (result.failed.length || result.failed_teams.length)
        throw new Error([...result.failed, ...result.failed_teams].map((failure) => failure.message).join('\n'));
    },
    [key, project, state, refresh],
  );
  const visible: Omit<State, 'key'> =
    state.key === key && key
      ? state
      : { status: key ? ('loading' as const) : ('idle' as const), error: null, nonMembers: [], roles: [] };
  return { ...visible, refresh, invite };
}
