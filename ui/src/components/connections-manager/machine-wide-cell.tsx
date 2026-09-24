import type * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { TableCell } from '../ui/table';

/**
 * "Used by" for a machine-level connection — the FlowPad account or a harness
 * login. It attaches to no project because every project on this computer
 * already uses it; a bare "—" read as "used by nothing".
 *
 * Same words the credential rows use for a user-scoped key ("All projects"),
 * so one column does not say one thing three ways.
 */
export function MachineWideCell() {
  const { t } = useLingui();
  return (
    <TableCell className="text-sm text-muted-foreground">
      <span title={t`Signed in on this computer, so every project here can use it`}>
        <Trans>All projects</Trans>
      </span>
    </TableCell>
  );
}

/**
 * The Actions cell for a row whose action is one text button (Logout, Details).
 *
 * `pe-10` = the cell's own 8px + the OAuth rows' 28px overflow menu and its 4px
 * gap, so every row's text action lines up in one column. One place, so a change
 * to that menu is one edit rather than a hunt for every copy.
 */
export function TextActionCell({ children }: { children: React.ReactNode }) {
  return <TableCell className="pe-10 text-end">{children}</TableCell>;
}
