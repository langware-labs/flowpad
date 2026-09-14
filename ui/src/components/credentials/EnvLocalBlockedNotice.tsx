import { Trans } from '@lingui/react/macro';

/** A `.env.local` a value cannot be written to — shown with the backend's reason. */
export function EnvLocalBlockedNotice({ reason, className }: { reason?: string | null; className?: string }) {
  return (
    <div
      className={className ?? 'rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm'}
      data-testid="env-local-blocked-notice"
    >
      {reason || (
        <Trans>
          .env.local is not ignored by git here, so a value written there would be committable. Add it to .gitignore
          first, or keep this credential in the encrypted vault.
        </Trans>
      )}
    </div>
  );
}
