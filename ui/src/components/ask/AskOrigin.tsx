import { FolderOpen } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { CredentialsSubview, Layout } from '@sdk';
import { badgeVariants } from '@src/components/ui/badge';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { AskQuestion } from './use-ask-question';

/** Where the asked-for credential is declared — a chip that opens it in that project's credentials, so the
 *  person sees which project the ways offered come from. */
export function AskOrigin({ origin }: { origin: NonNullable<AskQuestion['origin']> }) {
  const { navigation } = useDockNavigation();
  const open = () =>
    navigation.openDock(
      DockPointer.forCredentials(
        CredentialsSubview.CONNECTIONS,
        origin.project_id || undefined,
        Layout.DOCK,
        origin.credential || undefined,
      ),
    );
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        badgeVariants({ variant: 'outline' }),
        'mt-1 gap-1 font-normal text-muted-foreground hover:text-foreground',
      )}
      data-testid="ask-origin"
    >
      <FolderOpen className="size-3" />
      <Trans>From {origin.label}</Trans>
    </button>
  );
}
