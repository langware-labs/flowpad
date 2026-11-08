import type { Agent, NewPublicInviteCode } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { CopyButton } from '@src/components/ui/copy-button';
import { Input } from '@src/components/ui/input';

/** Name each just-minted code that was given one (who it is for). */
export async function saveCodeNames(agent: Agent, codes: NewPublicInviteCode[], names: Record<string, string>) {
  for (const c of codes) {
    const name = (names[c.id] ?? '').trim();
    if (name && name !== (c.name ?? '')) await agent.renamePublicCode(c.id, name);
  }
}

/**
 * Codes just minted, in plaintext — the only time the hub answers them — each with an optional name box, the
 * same in the New deployment wizard and in "Add invites".
 */
export function FreshCodes({
  codes,
  names,
  onName,
}: {
  codes: NewPublicInviteCode[];
  names: Record<string, string>;
  onName: (id: string, name: string) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" data-testid="invite-codes-new">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium">
          <Trans>Copy them now — they won't be shown again.</Trans>
        </p>
        <CopyButton
          value={codes.map((c) => (names[c.id]?.trim() ? `${c.code}  ${names[c.id].trim()}` : c.code)).join('\n')}
          label={<Trans>Copy all</Trans>}
          testId="invite-codes-copy-all"
          className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent"
        />
      </div>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {codes.map((c) => (
          <li key={c.id} className="flex items-center gap-2" data-testid="invite-code-fresh">
            <span className="w-28 shrink-0 font-mono text-sm">{c.code}</span>
            <Input
              className="h-7 min-w-0 flex-1 text-xs"
              placeholder={t`Name (optional)`}
              value={names[c.id] ?? ''}
              onChange={(e) => onName(c.id, e.target.value)}
              aria-label={t`Name for ${c.code}`}
              data-testid="invite-code-fresh-name"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
