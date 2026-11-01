import { useLingui } from '@lingui/react/macro';
import { Play } from 'lucide-react';
import { useLinks } from '@src/components/links/LinkMenu';
import { linkEventProps, type LinkSource } from '@src/components/links/link-events';
import { COMMAND_BUTTON_CLASS, CopyableCommand } from '@src/components/version-popover/version-popover';

/** No entity behind a credential's command: it runs in a new terminal, not in a session. */
const NO_SOURCE: { readonly current: LinkSource | null } = { current: null };

/**
 * A `cli` credential's sign-in command. On this computer it is a command link — click runs it,
 * right-click lists where (and Copy), the same as in the terminal. On another machine it is
 * copy-only: running it here would sign in the wrong machine. The credentials status refetches
 * on window focus, so the row turns signed-in once the person comes back from the sign-in.
 */
export function SignInCommand({ command, thisComputer }: { command: string; thisComputer: boolean }) {
  const { t } = useLingui();
  const { handlers, menu } = useLinks(NO_SOURCE, null);
  if (!thisComputer) return <CopyableCommand command={command} />;
  return (
    <>
      <button
        type="button"
        {...linkEventProps(handlers, `! ${command}`)}
        className={COMMAND_BUTTON_CLASS}
        title={t`Click to run · right-click for more`}
        data-testid="sign-in-command"
      >
        <span className="break-all text-start">{command}</span>
        <Play className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
      {menu}
    </>
  );
}
