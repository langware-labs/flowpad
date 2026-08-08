import { Trans, useLingui } from '@lingui/react/macro';
import { CredentialsSubview, PageId, ViewType, type Project } from '@sdk';
import { useAuth, useEntityEnv, useEntityEnvMutations } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@src/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { useProjectSecretOrigins } from '@src/hooks/use-project-secret-origins';
import { cn } from '@src/lib/utils';
import { AlertCircle, CheckCircle, ExternalLink, Minus, Plus, Trash2, XCircle } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { OriginChip } from '@src/components/secrets/OriginChip';
import { originKindSpec } from '@src/components/secrets/secret-origin-kinds';
import { credentialsPointer } from './credentials-pointer';
import { DeclareEnvVarDialog, type DeclareSubmit } from './DeclareEnvVarDialog';
import { ProvideValueInline } from './ProvideValueInline';
import { buildProjectEnvRows, type MetStatus, type ProjectEnvRow } from './project-environment-rows';

interface ProjectEnvironmentTabProps {
  project: Project;
  className?: string;
}

/**
 * Project Environment — what this project NEEDS, and whether the need is met.
 *
 * Two sources join on the one key they share, the env var name: SecretOrigin
 * declarations (value-free, they say what is needed and where it comes from) and
 * the live env-var table (what is actually set). A variable with no declaration
 * is a local secret the user supplied; an OAuth-derived variable is a connection,
 * shown here for completeness and managed in the Connections tab.
 *
 * All merging is in `project-environment-rows.ts`; this file renders and writes.
 */
export const ProjectEnvironmentTab: React.FC<ProjectEnvironmentTabProps> = ({ project, className }) => {
  const { t } = useLingui();
  const { user } = useAuth();
  const { navigation, currentDock } = useDockNavigation();

  const entityTypeId = project.typeId;
  const { table, isLoading, error } = useEntityEnv({ entityTypeId, enabled: !!user?.id });
  const envMutations = useEntityEnvMutations(entityTypeId);
  const { secretOrigins, status, statusReady, add, provide, remove, refreshStatus } =
    useProjectSecretOrigins(project);

  // Null when closed — the same shape as `confirming` below, and it cannot
  // express a closed dialog that still remembers a locked variable.
  const [declaring, setDeclaring] = useState<{ lockedEnvVar?: string } | null>(null);
  const [providingFor, setProvidingFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ProjectEnvRow | null>(null);

  const rows = useMemo(
    () => buildProjectEnvRows({ secretOrigins, status, statusReady, envRows: table?.values ?? [] }),
    [secretOrigins, status, statusReady, table],
  );

  /**
   * The two sides cache independently and either write can flip the other's
   * answer, so every mutation must settle both halves.
   *
   * They are settled asymmetrically because the writers already do half the job:
   * `add`/`provide`/`remove` refresh resolve-status themselves, so a write
   * through them needs only the env table invalidated here. `secretResolveStatus`
   * re-parses `.env.local` and walks the keychain on every call, so calling it a
   * second time per click is a real cost, not a spare round trip.
   */
  const invalidateEnvTable = useCallback(() => envMutations.invalidate(), [envMutations]);

  const handleDeclare = useCallback(
    async ({ envVar, description, locator, sodStore, scope, value }: DeclareSubmit) => {
      // `add` must land first — provide-secret looks the declaration up on the
      // project and fails outright when it is not there yet.
      await add({ name: envVar, envVar, description, locator, sodStore, scope });
      if (value.trim()) await provide({ envVar, value });
      invalidateEnvTable();
      notify.success({ title: t`Declared`, message: t`${envVar} is now declared for this project.` });
    },
    [add, provide, invalidateEnvTable, t],
  );

  const handleProvide = useCallback(
    async (row: ProjectEnvRow, value: string) => {
      try {
        await provide({ typeid: row.typeid, envVar: row.envVar, value });
        invalidateEnvTable();
        setProvidingFor(null);
      } catch (e) {
        notify.error({ title: t`Could not store value`, message: errorMessage(e, t`Failed to store the value`) });
      }
    },
    [provide, invalidateEnvTable, t],
  );

  const handleConfirmed = useCallback(async () => {
    const row = confirming;
    if (!row) return;
    try {
      if (row.rowKind === 'declared' && row.typeid) {
        // `remove` refreshed status; the env table is the half it cannot see.
        await remove(row.typeid);
        invalidateEnvTable();
      } else {
        // The mirror case: this writer invalidates the env table itself, and
        // dropping a value can unmet a declaration that was reading it.
        await envMutations.remove(row.envVar);
        await refreshStatus();
      }
    } catch (e) {
      notify.error({ title: t`Could not remove`, message: errorMessage(e, t`Failed to remove ${row.envVar}`) });
    }
  }, [confirming, remove, envMutations, invalidateEnvTable, refreshStatus, t]);

  const openConnections = useCallback(() => {
    navigation.openPage(
      currentDock?.page ?? PageId.DESK,
      ViewType.CREDENTIALS,
      credentialsPointer(CredentialsSubview.CONNECTIONS, project.id),
    );
  }, [navigation, currentDock?.page, project.id]);

  const existingEnvVars = rows.map((r) => r.envVar);

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="project-environment-tab">
      <div className="mb-3 flex items-center gap-2">
        <p className="text-xs text-muted-foreground">
          <Trans>What this project needs, where each value comes from, and whether it is met here.</Trans>
        </p>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => setDeclaring({})}
          data-testid="env-declare-open"
        >
          <Plus className="mr-1 h-4 w-4" />
          <Trans>Declare</Trans>
        </Button>
      </div>

      {error && (
        <div
          className="mb-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
          data-testid="env-vars-error"
        >
          {errorMessage(error, t`Could not load environment variables`)}
        </div>
      )}

      {isLoading && rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[220px]"><Trans>Variable</Trans></TableHead>
              <TableHead className="w-[240px]"><Trans>Comes from</Trans></TableHead>
              <TableHead className="w-[140px]"><Trans>Value</Trans></TableHead>
              <TableHead className="w-[150px]"><Trans>Met</Trans></TableHead>
              <TableHead><Trans>Description</Trans></TableHead>
              <TableHead className="w-[200px] text-right"><Trans>Actions</Trans></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <React.Fragment key={row.envVar}>
                <TableRow data-testid={`env-row-${row.envVar}`}>
                  <TableCell className="font-mono text-sm">{row.envVar}</TableCell>
                  <TableCell>
                    <OriginChip
                      kind={row.originKind}
                      coordinate={row.coordinate}
                      qualifier={row.rowKind === 'implicit' ? t`user-set` : undefined}
                      locator={row.locator as Record<string, unknown> | undefined}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <ValueCell row={row} />
                  </TableCell>
                  <TableCell>
                    <MetCell row={row} />
                  </TableCell>
                  <TableCell className="max-w-[1px] truncate text-sm text-muted-foreground">
                    {row.description || '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      row={row}
                      onProvide={() => setProvidingFor(row.envVar)}
                      onDeclare={() => setDeclaring({ lockedEnvVar: row.envVar })}
                      onRemove={() => setConfirming(row)}
                      onOpenConnections={openConnections}
                    />
                  </TableCell>
                </TableRow>
                {providingFor === row.envVar && (
                  <TableRow data-testid={`env-provide-${row.envVar}`}>
                    <TableCell colSpan={6} className="bg-muted/30">
                      <ProvideValueInline
                        envVar={row.envVar}
                        prompt={row.setupPrompt}
                        onSubmit={(value) => handleProvide(row, value)}
                        onCancel={() => setProvidingFor(null)}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}
            {rows.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  <Trans>
                    Nothing declared yet. Declare what this project needs — a declaration can sit
                    unmet until someone provides the value.
                  </Trans>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      <DeclareEnvVarDialog
        open={!!declaring}
        onOpenChange={(open) => !open && setDeclaring(null)}
        lockedEnvVar={declaring?.lockedEnvVar}
        existingEnvVars={existingEnvVars}
        onSubmit={handleDeclare}
      />

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        variant="destructive"
        title={
          confirming?.rowKind === 'declared'
            ? t`Stop declaring ${confirming.envVar}?`
            : t`Delete ${confirming?.envVar ?? ''}?`
        }
        description={
          confirming?.rowKind === 'declared'
            ? // Mirrors remove-secret-pointer: the pointer is unlinked, the value is not touched.
              t`The project will no longer ask for it. The stored value is not deleted.`
            : t`The value is removed from this project.`
        }
        confirmLabel={confirming?.rowKind === 'declared' ? t`Stop declaring` : t`Delete`}
        onConfirm={() => void handleConfirmed()}
      />
    </div>
  );
};

const ValueCell: React.FC<{ row: ProjectEnvRow }> = ({ row }) => {
  if (row.visibleValue) return <span>{row.visibleValue}</span>;
  // A met row holds its value somewhere this table cannot see — sodot, .env.local,
  // or the provider. Saying "Not set" next to a green Met would be a flat
  // contradiction; the masked form says "held, just not here".
  if (row.met === 'met') return <span>••••</span>;
  return (
    <span className="italic">
      <Trans>Not set</Trans>
    </span>
  );
};

const MET_META: Record<MetStatus, { icon: typeof CheckCircle; className: string }> = {
  met: { icon: CheckCircle, className: 'text-green-600' },
  missing: { icon: XCircle, className: 'text-amber-600' },
  'action-needed': { icon: AlertCircle, className: 'text-amber-600' },
  error: { icon: XCircle, className: 'text-destructive' },
  unknown: { icon: Minus, className: 'text-muted-foreground' },
};

const MetCell: React.FC<{ row: ProjectEnvRow }> = ({ row }) => {
  const { t } = useLingui();
  const { icon: Icon, className } = MET_META[row.met];

  // Worded per row kind: "Connected" and "Met" are the same fact about very
  // different things, and calling an OAuth grant "Met" reads as nonsense. Two
  // full tables rather than one with exceptions, so a new MetStatus is a type
  // error in both until it is worded for both.
  const OAUTH_LABEL: Record<MetStatus, string> = {
    met: t`Connected`,
    missing: t`Not connected`,
    'action-needed': row.needsReauth ? t`Reconnect needed` : t`Consent required`,
    error: t`Error`,
    unknown: t`Unknown`,
  };
  const DECLARED_LABEL: Record<MetStatus, string> = {
    met: t`Met`,
    missing: t`Missing`,
    'action-needed': t`Consent required`,
    error: t`Error`,
    unknown: t`Checking…`,
  };
  const label = (row.rowKind === 'oauth' ? OAUTH_LABEL : DECLARED_LABEL)[row.met];

  const FOUND_IN_DETAIL: Record<string, string> = {
    'env-local': t`from .env.local`,
    sodot: t`from the keychain`,
  };
  const detail =
    row.met === 'met' && row.foundIn
      ? (FOUND_IN_DETAIL[row.foundIn] ?? t`from the provider`)
      : undefined;

  const chip = (
    <span className={cn('flex items-center gap-1 text-xs', className)} data-testid={`env-met-${row.envVar}`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );

  if (!detail) return chip;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const RowActions: React.FC<{
  row: ProjectEnvRow;
  onProvide: () => void;
  onDeclare: () => void;
  onRemove: () => void;
  onOpenConnections: () => void;
}> = ({ row, onProvide, onDeclare, onRemove, onOpenConnections }) => {
  const { t } = useLingui();

  // An OAuth credential is not declared here and cannot be edited here. One door.
  if (row.rowKind === 'oauth') {
    return (
      <Button size="sm" variant="ghost" onClick={onOpenConnections} data-testid={`env-connections-${row.envVar}`}>
        <ExternalLink className="mr-1 h-3.5 w-3.5" />
        <Trans>Connections</Trans>
      </Button>
    );
  }

  const provideable = row.rowKind === 'declared' && (originKindSpec(row.originKind)?.provideable ?? false);

  return (
    <div className="flex items-center justify-end gap-1">
      {provideable && (
        <Button
          size="sm"
          variant={row.met === 'met' ? 'ghost' : 'outline'}
          onClick={onProvide}
          data-testid={`env-provide-open-${row.envVar}`}
        >
          {row.met === 'met' ? <Trans>Replace</Trans> : <Trans>Set up</Trans>}
        </Button>
      )}
      {row.rowKind === 'declared' && row.comingSoon && (
        <span className="text-xs text-muted-foreground">
          <Trans>coming soon</Trans>
        </span>
      )}
      <Button size="sm" variant="ghost" onClick={onDeclare} data-testid={`env-declare-${row.envVar}`}>
        {row.rowKind === 'declared' ? <Trans>Change origin</Trans> : <Trans>Declare origin</Trans>}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={onRemove}
        aria-label={t`Remove ${row.envVar}`}
        data-testid={`env-remove-${row.envVar}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
};
