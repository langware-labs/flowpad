/**
 * A root endpoint's provider key: write-only.
 *
 * The value only ever lives in a password input and in the request body of
 * `setCredential`/`testCredential`; it is cleared after Save and never rendered
 * as text — the ONLY thing echoed back is the hub's masked hint (`****abcd`).
 * Two modes:
 *   - `endpointId` set: Save/Test go to the hub, and the stored hint + Delete
 *     appear;
 *   - no `endpointId` (create flow): the field is a plain controlled input; the
 *     dialog sends the key AFTER the entity exists. Test is unavailable until
 *     the endpoint exists (the test action needs a target).
 */
import { llmEndpointsService, type LLMCredentialTestResult } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, Check, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { TONE } from './tone';

export interface CredentialFieldProps {
  /** The endpoint the key belongs to; undefined while it is not yet created. */
  endpointId?: string;
  /** The hub's masked marker (`""` when none stored). */
  credentialHint?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** After a hub-side change (save/delete), so the owner can refresh the hint. */
  onStored?: (hint: string) => void;
  disabled?: boolean;
}

export function CredentialField({
  endpointId,
  credentialHint = '',
  placeholder,
  value,
  onChange,
  onStored,
  disabled,
}: CredentialFieldProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null);
  const [verdict, setVerdict] = useState<LLMCredentialTestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canReachHub = !!endpointId;

  const save = async () => {
    if (!endpointId || !value.trim()) return;
    setBusy('save');
    try {
      const res = await llmEndpointsService.setCredential(endpointId, value.trim());
      onChange('');
      setVerdict(null);
      onStored?.(res.credential_hint);
      notify.success({ title: t`Key saved` });
    } catch (e) {
      notify.error({ title: t`Could not save the key`, message: errorMessage(e, '') });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!endpointId) return;
    setBusy('test');
    try {
      // A typed-but-unsaved key is tested WITHOUT being stored; otherwise the
      // stored one is tested.
      const res = await llmEndpointsService.testCredential(endpointId, value.trim() || undefined);
      setVerdict(res);
    } catch (e) {
      setVerdict({ valid: false, status: 0, models_count: 0, message: errorMessage(e, t`Test failed`) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!endpointId) return;
    setBusy('delete');
    try {
      await llmEndpointsService.deleteCredential(endpointId);
      setVerdict(null);
      onStored?.('');
      notify.success({ title: t`Key removed` });
    } catch (e) {
      notify.error({ title: t`Could not remove the key`, message: errorMessage(e, '') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5" data-testid="credential-field">
      <Label htmlFor="llm-credential">
        <Trans>Provider API key</Trans>
      </Label>
      <div className="flex gap-2">
        <Input
          id="llm-credential"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          placeholder={placeholder ?? (credentialHint ? t`Replace the stored key` : t`Paste API key`)}
          disabled={disabled || busy !== null}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canReachHub && void save()}
          data-testid="credential-input"
        />
        {canReachHub && (
          <>
            <Button
              type="button"
              disabled={disabled || busy !== null || !value.trim()}
              onClick={() => void save()}
              data-testid="credential-save"
            >
              {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Save</Trans>}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || busy !== null || (!value.trim() && !credentialHint)}
              onClick={() => void test()}
              data-testid="credential-test"
            >
              {busy === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Test</Trans>}
            </Button>
          </>
        )}
      </div>
      <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
        {credentialHint ? (
          <span className="flex items-center gap-1.5" data-testid="credential-hint">
            <Trans>Stored key</Trans>
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{credentialHint}</code>
            {canReachHub && (
              <button
                type="button"
                aria-label={t`Delete key`}
                data-testid="credential-delete"
                className="text-muted-foreground hover:text-destructive"
                disabled={disabled || busy !== null}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        ) : (
          <span>
            {canReachHub ? (
              <Trans>No key stored — this root cannot serve requests until one is saved.</Trans>
            ) : (
              <Trans>Saved after the endpoint is created. Never shown again.</Trans>
            )}
          </span>
        )}
        {verdict && (
          <Badge
            variant="outline"
            className={`gap-1 ${verdict.valid ? TONE.emerald : TONE.destructive}`}
            title={verdict.message ?? undefined}
            data-testid="credential-verdict"
          >
            {verdict.valid ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
            {verdict.valid ? t`Valid (${verdict.models_count} models)` : t`Invalid (${verdict.status})`}
          </Badge>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="destructive"
        title={t`Delete the stored key?`}
        description={t`Requests through this root will fail until a new key is saved.`}
        confirmLabel={t`Delete`}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
