import { useLingui } from '@lingui/react/macro';

/** Which side of the live session this user is: the host runs the prompts on
 *  their machine, the guest sends them. */
export function SessionRoleBadge({ role }: { role: 'host' | 'guest' | 'observer' }) {
  const { t } = useLingui();
  if (role === 'observer') return null;
  const host = role === 'host';
  return (
    <span
      data-testid="live-session-role"
      data-role={role}
      title={
        host
          ? t`You are the host — prompts run on your machine`
          : t`You are the guest — prompts run on the host's machine`
      }
      className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
    >
      {host ? t`Host` : t`Guest`}
    </span>
  );
}
