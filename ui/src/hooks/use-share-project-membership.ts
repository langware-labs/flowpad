import { useCallback, useEffect, useRef, useState } from 'react';
import { membershipService, Role, type Membership, type Project } from '@sdk';

export const NO_PROJECT_ROLE = 'none';
const identity = (value: string) => (value.includes('@') ? value.trim().toLowerCase() : value.replace(/^user-/, ''));
/** Recipients that no roster member `counted` matches, by user id or email. */
function recipientsNotIn(recipients: string[], roster: Membership[], counted: (m: Membership) => boolean = () => true) {
  const known = new Set(
    roster.filter(counted).flatMap((member) => [member.user_id, member.user_email].filter(Boolean).map(identity)),
  );
  return recipients.filter((recipient) => !known.has(identity(recipient)));
}
export function projectNonMembers(recipients: string[], roster: Membership[]): string[] {
  return recipientsNotIn(recipients, roster);
}
/** Roles that don't give access to the project's files: a guest only sees what
 *  is shared with them, and a pending invitation grants nothing yet. */
const NO_FILE_ACCESS_ROLES = new Set<string>([Role.GUEST, Role.ANONYMOUS_VIEWER]);

/** Recipients who can't read the project's files themselves — they need a copy,
 *  not a git reference. */
export function projectOutsiders(recipients: string[], roster: Membership[]): string[] {
  return recipientsNotIn(recipients, roster, (m) => m.status !== 'pending' && !NO_FILE_ACCESS_ROLES.has(m.role));
}
const EMPTY = { error: null, nonMembers: [] as string[], outsiders: [] as string[], roles: [] as string[] };
type State = {
  key: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  nonMembers: string[];
  /** Recipients without access to the project's files (includes guests and pending invites). */
  outsiders: string[];
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
  const [state, setState] = useState<State>({ key: '', status: 'idle', ...EMPTY });
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    if (!key || !project) return;
    setState({ key, status: 'loading', ...EMPTY });
    try {
      const [roster, roles] = await Promise.all([
        membershipService.fetchMembershipsStrict(project.typeId),
        membershipService.fetchShareRoles(),
      ]);
      if (!roles.length) throw new Error('Could not load project roles.');
      if (request !== revision.current || key !== currentKey.current) return;
      const successful = invited.current;
      const recipients: string[] = JSON.parse(recipientsKey);
      const nonMembers = projectNonMembers(recipients, roster).filter(
        (recipient) => !successful.has(identity(recipient)),
      );
      const outsiders = projectOutsiders(recipients, roster);
      setState({ key, status: 'ready', error: null, nonMembers, outsiders, roles });
    } catch (error) {
      if (request !== revision.current || key !== currentKey.current) return;
      setState({
        key,
        status: 'error',
        ...EMPTY,
        error: error instanceof Error ? error.message : 'Could not load project members.',
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
      : { status: key ? ('loading' as const) : ('idle' as const), ...EMPTY };
  return { ...visible, refresh, invite };
}
