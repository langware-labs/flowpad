import { Trans } from '@lingui/react/macro';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { cn } from '@src/lib/utils';
import { Trash2 } from 'lucide-react';
import React from 'react';

import { FlowPadApiKeyPanel, GeneratedApiKeyCallout } from './FlowPadApiKeyPanel';
import { useUserApiKeys } from './use-user-api-keys';

export interface ApiKeysViewProps {
  className?: string;
  /** Render the "API Keys" heading. Off when a host surface supplies its own. */
  header?: boolean;
}

/**
 * The signed-in user's API keys.
 *
 * Owns no frame: no height, no padding, no width cap. Hosts differ — a tab pane
 * already scrolls and pads, a standalone route does not — and a component that
 * assumes one double-pads in the other.
 */
export const ApiKeysView: React.FC<ApiKeysViewProps> = ({ className, header = true }) => {
  const keys = useUserApiKeys();

  return (
    <div className={cn('space-y-6', className)} data-testid="api-keys-view">
      {header && (
        <div>
          <h2 className="text-2xl font-bold text-foreground">
            <Trans>API Keys</Trans>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <Trans>Manage your FlowPad API keys for authenticating API requests</Trans>
          </p>
        </div>
      )}

      <FlowPadApiKeyPanel keys={keys} />

      {keys.generatedKey && <GeneratedApiKeyCallout apiKey={keys.generatedKey} />}

      {keys.apiKeys.length > 0 && (
        <div className="rounded-lg border border-border bg-transparent">
          <div className="border-b border-border p-4">
            <h3 className="text-base font-semibold text-foreground">
              <Trans>Your API Keys</Trans>
            </h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Name</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Description</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Value</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Status</Trans>
                </TableHead>
                <TableHead className="text-end">
                  <Trans>Actions</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.apiKeys.map((apiKey) => (
                <TableRow key={apiKey.id} data-testid={`api-key-row-${apiKey.id}`}>
                  <TableCell className="font-mono text-sm text-foreground">{apiKey.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{apiKey.description || '-'}</TableCell>
                  <TableCell>
                    <span className="font-mono text-sm text-muted-foreground">{apiKey.visible_value}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={apiKey.is_active ? 'default' : 'secondary'}>
                      {apiKey.is_active ? <Trans>Active</Trans> : <Trans>Inactive</Trans>}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void keys.remove(apiKey)}
                      disabled={!apiKey.is_active}
                      className="flex items-center gap-1"
                      data-testid={`api-key-delete-${apiKey.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};
