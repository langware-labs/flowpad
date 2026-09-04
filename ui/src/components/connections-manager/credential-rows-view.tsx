import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';
import { lucideByName } from '@src/lib/lucide-by-name';
import { KeyRound } from 'lucide-react';
import { Badge } from '../ui/badge';
import { MoreOnHover } from './more-on-hover';
import { Button } from '../ui/button';
import { ProvideValueInline } from '@src/components/credentials-view/ProvideValueInline';
import { TableCell, TableRow } from '../ui/table';
import { CONNECTIONS_COLUMN_COUNT } from '../connections-manager';
import type { CredentialRow } from '@src/components/credentials-view/credential-rows';

/** Same cap the OAuth scope chips use — one chip and a count. The column is one
 *  line, and four chips wrapped the row to four lines. */
const VARS_SHOWN = 1;

/** The provider glyph for a credential row.
 *
 *  From the definition's `icon_name`, which is asset data rather than a TYPE
 *  icon — the row is a provider, not an entity type, so `iconForType` is the
 *  wrong registry. Falls back to a key glyph, never to nothing. */
function CredentialGlyph({ iconName }: { iconName?: string }) {
  const Icon = iconName ? lucideByName(iconName) : null;
  return Icon ? (
    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : (
    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
  );
}

/**
 * Credential rows for the Connections table.
 *
 * A fragment of `<TableRow>`s rather than its own table: the whole point is that
 * an API credential is not a second kind of thing beside an OAuth connection —
 * it is the same row with a different sign-in.
 */
export function CredentialConnectionRows({
  rows,
  onProvide,
  onAdopt,
  onDelete,
  adoptingKey,
}: {
  rows: CredentialRow[];
  /** Write one member's value. Declaration-first is already guaranteed: a row
   *  only offers this for members a `SecretOrigin` declares. */
  onProvide?: (envVar: string, value: string) => Promise<void>;
  /** Adopt a detected-but-undeclared credential: declare all of its variables.
   *  Without this a row whose values are already on disk is a dead end — it is
   *  shown in the table, and therefore excluded from Add connection, so there
   *  would be nowhere left to add it from. */
  onAdopt?: (rowKey: string) => Promise<void>;
  /** Delete the credential: its declarations, and the values it is ours to
   *  delete. See `deleteCredential` — a value in the user's `.env.local` stays,
   *  and the confirm dialog is where that is said. */
  onDelete?: (row: CredentialRow) => void;
  /** Row key currently being adopted, so the button can spell "working". */
  adoptingKey?: string | null;
}) {
  const { t } = useLingui();
  const [settingUp, setSettingUp] = React.useState<string | null>(null);

  // In-component, like `statusLabel` in the host: a module-level map of raw
  // strings escapes lingui extraction.
  // Short by necessity: the OAuth rows put their status on one line, and a
  // wrapping label here is what made the two halves of the table look like two
  // different tables. The detail moves to the title attribute.
  // An API credential has ONE state worth a word: the key is present, so it is
  // enabled. There is no "detected" (that is just enabled) and no "0 of 2" (a
  // credential without its values is not a connection — it is not a row at all,
  // it is an entry in the Add dialog). `credential-rows.ts` enforces that.
  const statusText = (): string => t`Enabled`;

  const dot = (): string => 'bg-emerald-500';

  return (
    <>
      {rows.map((row) => {
        const shown = row.members.slice(0, VARS_SHOWN);
        const extra = row.members.length - shown.length;
        const unset = row.members.filter((m) => m.declared && m.state !== 'met');
        const showAdopt = !!onAdopt && row.declaredCount === 0 && row.adoptableCount > 0;
        const showSetup = !!onProvide && row.declaredCount > 0 && row.state !== 'connected';
        const showDelete = !!onDelete && row.declaredCount > 0;
        return (
          <React.Fragment key={`credential:${row.key}`}>
          <TableRow data-testid={`connection-row-${row.key}`}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2">
                <CredentialGlyph iconName={row.iconName} />
                <span>{row.title}</span>
              </div>
            </TableCell>

            <TableCell>
              <Badge
                variant="outline"
                className="text-xs font-normal"
                title={t`Values you paste, kept in this project's environment`}
                data-testid={`connection-kind-${row.key}`}
              >
                <Trans>API</Trans>
              </Badge>
            </TableCell>

            {/* Requirement 5: an API credential's "access requested" IS its set
                of environment variables. Same badge shape the OAuth scopes use,
                so the two read as one column. */}
            <TableCell data-testid={`connection-vars-${row.key}`}>
              <MoreOnHover
                lines={row.members.map((m) => `${m.envVar}${m.required ? '' : t` (optional)`}`)}
              >
                <div className="flex items-center gap-1">
                  {shown.map((m) => (
                    <Badge
                      key={m.envVar}
                      variant="secondary"
                      className={cn(
                        'max-w-[220px] truncate font-mono text-[11px] font-normal',
                        m.state === 'missing' && 'opacity-50',
                      )}
                      title={
                        m.state === 'met'
                          ? t`Set${m.foundIn ? ` — from ${m.foundIn}` : ''}`
                          : m.state === 'adoptable'
                            ? t`In .env.local at line ${m.line ?? 0}, not declared yet`
                            : t`Not set`
                      }
                    >
                      {m.envVar}
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
                <span className={cn('h-2 w-2 shrink-0 rounded-full', dot())} />
                <span
                  className="whitespace-nowrap text-emerald-600"
                  data-testid={`connection-status-${row.key}`}
                >
                  {statusText()}
                </span>
              </div>
            </TableCell>

            <TableCell className="text-sm text-muted-foreground">—</TableCell>
            <TableCell className="text-end">
              {showAdopt && (
                <Button
                  size="sm"
                  className="h-7"
                  disabled={adoptingKey === row.key}
                  onClick={() => void onAdopt?.(row.key)}
                  data-testid={`connection-adopt-${row.key}`}
                >
                  {adoptingKey === row.key ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
                </Button>
              )}
              {showSetup && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => setSettingUp(settingUp === row.key ? null : row.key)}
                  data-testid={`connection-setup-${row.key}`}
                >
                  <Trans>Set up</Trans>
                </Button>
              )}
              {showDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ms-1 h-7 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete?.(row)}
                  data-testid={`connection-delete-${row.key}`}
                >
                  <Trans>Delete</Trans>
                </Button>
              )}
              {/* The cell is never blank: a row with no action still gets a dash,
                  which the three-way ternary this replaced could not express once
                  Delete became a fourth outcome. */}
              {!showAdopt && !showSetup && !showDelete && (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>

          {/* One field per variable still waiting — the answer to "it says not
              connected and I cannot tell why". `ProvideValueInline` is reused
              verbatim: it is one-way, never reads a value back, and Enter saves. */}
          {settingUp === row.key && (
            <TableRow data-testid={`connection-setup-panel-${row.key}`}>
              <TableCell colSpan={CONNECTIONS_COLUMN_COUNT} className="bg-muted/30">
                <div className="space-y-2 py-1">
                  {unset.map((m) => (
                    <div key={m.envVar} className="flex items-center gap-3">
                      <code className="w-56 shrink-0 text-xs">{m.envVar}</code>
                      <ProvideValueInline
                        envVar={m.envVar}
                        prompt={m.hint || m.placeholder || t`Enter ${m.label}`}
                        onSubmit={async (value) => {
                          await onProvide?.(m.envVar, value);
                        }}
                        onCancel={() => setSettingUp(null)}
                      />
                      {m.helpUrl && (
                        <a
                          href={m.helpUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-muted-foreground underline"
                        >
                          <Trans>Where do I get this?</Trans>
                        </a>
                      )}
                    </div>
                  ))}
                  {/* The destination is not the same for every row, and saying
                      the wrong one is worse than saying nothing: ".env.local,
                      git-ignored" is a reassurance about a file, and a key bound
                      for the encrypted store is not going into a file at all —
                      it is going somewhere every project on this machine reads. */}
                  <p className="text-xs text-muted-foreground">
                    {row.sodStore === 'sodot' ? (
                      <Trans>
                        Saved to this machine&apos;s encrypted store. Available to every project
                        here, and never written to a file or sent anywhere.
                      </Trans>
                    ) : (
                      <Trans>Saved to this project&apos;s .env.local, which stays git-ignored.</Trans>
                    )}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          )}
          </React.Fragment>
        );
      })}
    </>
  );
}
