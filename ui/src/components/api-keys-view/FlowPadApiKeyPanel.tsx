import { Trans, useLingui } from '@lingui/react/macro';
import type { ApiKeyCredentials } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { AlertCircle, Copy, Key, Trash2 } from 'lucide-react';
import React from 'react';

import type { UseUserApiKeys } from './use-user-api-keys';

/**
 * The Flowpad API key panel — one implementation, previously two.
 *
 * Split into two exports rather than one because `ApiKeysView` puts its full
 * key table *between* the panel and the just-generated-key callout, so they
 * cannot be a single block.
 */

interface FlowPadApiKeyPanelProps {
  keys: UseUserApiKeys;
  className?: string;
}

export const FlowPadApiKeyPanel: React.FC<FlowPadApiKeyPanelProps> = ({ keys, className }) => {
  const existing = keys.flowpadKey;

  return (
    <div
      className={cn('rounded-lg border border-border bg-transparent p-6', className)}
      data-testid="flowpad-api-key-panel"
    >
      <div className="mb-4">
        <h3 className="text-base font-semibold text-foreground">
          <Trans>FlowPad API Key</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          {existing ? (
            <Trans>Your API key for authenticating API requests to FlowPad</Trans>
          ) : (
            <Trans>Generate an API key to authenticate API requests to FlowPad</Trans>
          )}
        </p>
      </div>

      {existing ? (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-transparent p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                <Trans>Name:</Trans>
              </span>
              <span className="font-mono text-sm text-foreground">{existing.name}</span>
            </div>
            {existing.description && (
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  <Trans>Description:</Trans>
                </span>
                <span className="text-sm text-muted-foreground">{existing.description}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                <Trans>Value:</Trans>
              </span>
              <span className="font-mono text-sm text-muted-foreground">{existing.visible_value}</span>
            </div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void keys.remove(existing)}
            className="flex items-center gap-2"
            data-testid="flowpad-api-key-delete"
          >
            <Trash2 className="h-4 w-4" />
            <Trans>Delete API Key</Trans>
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          onClick={() => void keys.generate()}
          className="flex items-center gap-2"
          data-testid="flowpad-api-key-generate"
        >
          <Key className="h-4 w-4" />
          <Trans>Generate FlowPad API Key</Trans>
        </Button>
      )}
    </div>
  );
};

interface GeneratedApiKeyCalloutProps {
  apiKey: ApiKeyCredentials;
  className?: string;
}

/** The one moment the full secret is visible. It is never re-fetchable. */
export const GeneratedApiKeyCallout: React.FC<GeneratedApiKeyCalloutProps> = ({ apiKey, className }) => {
  const { t } = useLingui();

  return (
    <div
      className={cn('rounded-lg border-2 border-yellow-500/50 bg-yellow-500/10 p-4', className)}
      data-testid="generated-api-key"
    >
      <div className="mb-3 flex items-center gap-2 rounded bg-yellow-500/20 p-2 text-sm">
        <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-500" />
        <strong className="text-foreground">
          <Trans>Important:</Trans>
        </strong>{' '}
        <span className="text-muted-foreground">
          <Trans>Save this API key now. You won&apos;t be able to see it again!</Trans>
        </span>
      </div>
      <div className="flex gap-3">
        <Textarea
          value={apiKey.api_key}
          readOnly
          className="flex-1 font-mono text-sm"
          style={{ fontFamily: 'Monaco, Menlo, Consolas, monospace' }}
          rows={3}
        />
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(apiKey.api_key);
            notify.success({ title: t`Copied to Clipboard`, message: t`API key copied successfully` });
          }}
          variant="outline"
          size="sm"
          className="flex items-center gap-2"
        >
          <Copy className="h-4 w-4" />
          <Trans>Copy</Trans>
        </Button>
      </div>
    </div>
  );
};
