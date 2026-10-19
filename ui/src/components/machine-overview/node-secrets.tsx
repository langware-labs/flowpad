import { Trans, useLingui } from '@lingui/react/macro';
import type { ComputeNode, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useNodeSecrets } from '@src/hooks/use-node-secrets';
import { notify } from '@src/notifications';
import { KeyRound } from 'lucide-react';
import React, { useState } from 'react';

interface NodeSecretsProps {
  computeNode: ComputeNode | null | undefined;
  project: Project | null | undefined;
}

/**
 * Which of this project's secrets the node may see.
 *
 * Value-free throughout: the rows are env var names, and a value never reaches
 * this surface. Attaching is what governs workers, the connector's commands and
 * terminals alike — so the list is the node's whole view of the project.
 */
export const NodeSecrets: React.FC<NodeSecretsProps> = ({ computeNode, project }) => {
  const { t } = useLingui();
  const { rows, allAttached, ready, toggle, attachAll } = useNodeSecrets(computeNode, project);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      notify.error({
        title: t`Error`,
        message: e instanceof Error ? e.message : t`Could not update attached secrets`,
      });
    } finally {
      setBusy(null);
    }
  };

  if (!project) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="node-secrets-no-project">
        <Trans>Open a project to choose which of its secrets this machine can see.</Trans>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-3" data-testid="node-secrets">
      <div className="mb-2 flex items-center gap-2">
        <KeyRound className="h-4 w-4" />
        <span className="text-sm font-semibold">
          <Trans>Project secrets on this machine</Trans>
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ms-auto h-7 text-[11px]"
          disabled={busy !== null || rows.length === 0}
          onClick={() => void run('__all__', attachAll)}
          data-testid="node-secrets-attach-all"
        >
          <Trans>Attach all</Trans>
        </Button>
      </div>

      {allAttached && rows.length > 0 && (
        <div className="mb-2 text-[11px] text-muted-foreground" data-testid="node-secrets-all-note">
          <Trans>Nothing has been narrowed yet, so this machine sees every secret below.</Trans>
        </div>
      )}

      {ready && rows.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">
          <Trans>This project has no secrets declared yet.</Trans>
        </div>
      ) : (
        <ul className="flex flex-col gap-1 overflow-auto">
          {rows.map((row) => (
            <li
              key={row.env_var}
              className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-xs"
              data-testid={`node-secret-row-${row.env_var}`}
            >
              <input
                type="checkbox"
                checked={row.attached}
                disabled={busy !== null}
                onChange={(e) => void run(row.env_var, () => toggle(row.env_var, e.target.checked))}
                aria-label={row.env_var}
                data-testid={`node-secret-toggle-${row.env_var}`}
              />
              <code className="font-medium">{row.env_var}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
