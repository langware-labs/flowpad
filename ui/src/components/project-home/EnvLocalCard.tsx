import { Trans, useLingui } from '@lingui/react/macro';
import type { Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useProjectEnvLocal } from '@src/hooks/use-project-env-local';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { FileWarning, Plus, ShieldAlert } from 'lucide-react';
import React, { useState } from 'react';

interface EnvLocalCardProps {
  project: Project | null | undefined;
}

/**
 * Keys detected in the project's `.env.local`.
 *
 * Two rules this surface exists to hold:
 *
 * 1. **Names only.** The action returns key names and line numbers; there is no
 *    value here to render, by construction rather than by discipline.
 * 2. **Nothing is ever deleted from `.env.local`.** The project's own tooling
 *    reads that file. "Declare" is purely additive — it writes a declaration
 *    and leaves the file alone. There is deliberately no remove affordance.
 *
 * When the file is committable the whole surface is blocked, not warned: a
 * secret written into a tracked or unignored file leaks on the next push.
 */
export const EnvLocalCard: React.FC<EnvLocalCardProps> = ({ project }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { keys, blocked, blockReason, path, ready, declare } = useProjectEnvLocal(project);
  const [busy, setBusy] = useState<string | null>(null);

  const openAtLine = (line: number) => {
    if (!path) return;
    // Click → navigate, and nothing else. The loader resolves what is shown.
    navigation.openMachinePath(path, LOCAL_COMPUTE_NODE, { line });
  };

  const handleDeclare = async (key: string) => {
    setBusy(key);
    try {
      await declare(key);
    } catch (e) {
      notify.error({
        title: t`Error`,
        message: e instanceof Error ? e.message : t`Could not declare that key`,
      });
    } finally {
      setBusy(null);
    }
  };

  if (ready && keys.length === 0 && !blocked) return null;

  return (
    <div className="rounded-lg border border-border p-3" data-testid="env-local-card">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <FileWarning className="h-4 w-4" />
        <Trans>Detected in .env.local</Trans>
      </div>

      {blocked && (
        <div
          className="mb-2 flex items-start gap-2 rounded border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
          data-testid="env-local-block"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{blockReason}</span>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="px-1 py-1 text-[11px] text-muted-foreground">
          <Trans>No keys found in this project's .env.local.</Trans>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {keys.map((row) => (
            <li
              key={row.key}
              className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-xs"
              data-testid={`env-local-row-${row.key}`}
            >
              <button
                type="button"
                onClick={() => openAtLine(row.line)}
                className="font-mono text-primary hover:underline"
                title={t`Open .env.local at this line`}
                data-testid={`env-local-open-${row.key}`}
              >
                {row.key}
              </button>
              <span className="text-[10px] text-muted-foreground">
                <Trans>line {row.line}</Trans>
              </span>
              {row.declared ? (
                <span className="ms-auto text-[10px] text-muted-foreground">
                  <Trans>Declared</Trans>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto h-6 text-[10px]"
                  disabled={busy === row.key || blocked}
                  onClick={() => void handleDeclare(row.key)}
                  data-testid={`env-local-declare-${row.key}`}
                >
                  <Plus className="me-0.5 h-3 w-3" />
                  <Trans>Declare</Trans>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
