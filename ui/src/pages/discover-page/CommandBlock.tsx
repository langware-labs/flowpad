import { Trans } from '@lingui/react/macro';
import { CopyableCommand } from '@src/components/version-popover/version-popover';
import { bootstrapCommand, installCommand } from './discover-model';

/**
 * The install command IS the page's lead: for the hovered or selected row its
 * `flow asset install <typeid>`, otherwise the three lines that make a machine
 * a signed-in desktop. One copyable line, one caption.
 */
export function CommandBlock({ typeid }: { typeid: string | null }) {
  return (
    <section className="rounded-lg border border-border bg-card p-3" data-testid="discover-command-block">
      <CopyableCommand command={typeid ? installCommand(typeid) : bootstrapCommand()} />
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {typeid ? (
          <Trans>Paste into a terminal on a machine running Flowpad and signed in. Or use Install.</Trans>
        ) : (
          <Trans>First time? Install Flowpad, then hover a row for its install line.</Trans>
        )}
      </p>
    </section>
  );
}
