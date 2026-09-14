import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { KeyRound, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { lucideByName } from '@src/lib/lucide-by-name';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { TableCell, TableRow } from '../ui/table';
import { MoreOnHover } from './more-on-hover';
import type { CredentialRow } from '@src/components/credentials-view/credential-rows';

/** Same cap the OAuth scope chips use — one chip and a count. */
const VARS_SHOWN = 1;

/** The provider glyph, from the definition's `icon_name` — asset data, not a type icon. */
function CredentialGlyph({ iconName }: { iconName?: string }) {
  const Icon = (iconName && lucideByName(iconName)) || KeyRound;
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

/**
 * Credential rows for the Connections table — `<TableRow>`s in the one table, so
 * a pasted API key reads as the same kind of thing as an OAuth sign-in.
 */
export function CredentialConnectionRows({
  rows,
  onSetValues,
  onEdit,
  onDelete,
}: {
  rows: CredentialRow[];
  onSetValues: (row: CredentialRow) => void;
  onEdit: (row: CredentialRow) => void;
  onDelete: (row: CredentialRow) => void;
}) {
  const { t } = useLingui();

  return (
    <>
      {rows.map((row) => {
        const testKey = `${row.scope}-${row.name}`;
        const shown = row.vars.slice(0, VARS_SHOWN);
        const extra = row.vars.length - shown.length;
        const connected = row.state === 'connected';
        return (
          <TableRow key={row.typeid} data-testid={`connection-row-${testKey}`}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2">
                <CredentialGlyph iconName={row.iconName} />
                <span className="truncate" title={row.description}>
                  {row.title}
                </span>
              </div>
            </TableCell>

            <TableCell>
              <Badge
                variant="outline"
                className="rounded-full px-2 text-[11px] font-medium text-muted-foreground"
                title={
                  row.store === 'vault'
                    ? t`Values are kept in this machine's encrypted vault`
                    : row.scope === 'user'
                      ? t`Values are kept in .env.local in your home folder`
                      : t`Values are kept in this project's .env.local`
                }
                data-testid={`connection-store-${testKey}`}
              >
                {row.store === 'vault' ? <Trans>Vault</Trans> : <Trans>Env file</Trans>}
              </Badge>
            </TableCell>

            <TableCell data-testid={`connection-vars-${testKey}`}>
              <MoreOnHover
                lines={row.vars.map(
                  (v) =>
                    `${v.envVar}${v.required ? '' : t` (optional)`}${v.present ? '' : t` — not set`}${v.warning === 'wrong-store' ? t` (value is in the other store)` : ''}`,
                )}
              >
                <div className="flex items-center gap-1">
                  {shown.map((v) => (
                    <Badge
                      key={v.envVar}
                      variant="secondary"
                      className={cn(
                        'max-w-[220px] truncate font-mono text-[11px] font-normal',
                        !v.present && 'opacity-50',
                      )}
                    >
                      {v.envVar}
                    </Badge>
                  ))}
                  {!!extra && (
                    <span className="shrink-0 cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-2">
                      +{extra}
                    </span>
                  )}
                </div>
              </MoreOnHover>
            </TableCell>

            <TableCell>
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={cn('h-2 w-2 shrink-0 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')}
                />
                <span
                  className={cn('whitespace-nowrap', connected ? 'text-emerald-600' : 'text-amber-600')}
                  title={row.missing.length ? t`Missing: ${row.missing.join(', ')}` : undefined}
                  data-testid={`connection-status-${testKey}`}
                >
                  {connected ? <Trans>Connected</Trans> : <Trans>Needs values</Trans>}
                </span>
              </div>
            </TableCell>

            <TableCell className="text-sm text-muted-foreground" data-testid={`connection-scope-${testKey}`}>
              <span title={row.shadowed ? t`This project declares the same variables, and its values win` : undefined}>
                {row.scope === 'user' ? <Trans>All projects</Trans> : <Trans>This project</Trans>}
                {row.shadowed && (
                  <span className="ms-1 text-xs text-muted-foreground/70">
                    <Trans>(overridden)</Trans>
                  </span>
                )}
              </span>
            </TableCell>

            <TableCell className="text-end">
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant={connected ? 'ghost' : 'outline'}
                  size="sm"
                  className="h-7"
                  onClick={() => onSetValues(row)}
                  data-testid={`connection-setvalues-${testKey}`}
                >
                  {connected ? <Trans>Update values</Trans> : <Trans>Set values</Trans>}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      title={t`More`}
                      data-testid={`connection-more-${testKey}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onEdit(row)} data-testid={`connection-edit-${testKey}`}>
                      <Pencil className="me-2 h-3.5 w-3.5" />
                      <Trans>Edit</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => onDelete(row)}
                      data-testid={`connection-delete-${testKey}`}
                    >
                      <Trash2 className="me-2 h-3.5 w-3.5" />
                      <Trans>Delete</Trans>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
