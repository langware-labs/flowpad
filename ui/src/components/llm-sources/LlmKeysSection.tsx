/**
 * The API keys stored on this machine — one slot per provider, and the form that fills one.
 *
 * Moved here from the Assistants & keys modal, where it sat behind a "Key not set" row: this is
 * the `keys` section of LLM sources (`/dock/llm-sources/keys`), the page every Details button
 * lands on. The slots come from the STATUS record (`keys[].stored` and the masked `hint`), so
 * the modal's "N of 3 set" and this list count the same thing; save and delete invalidate both
 * status and funding, because a key changes what can pay.
 */
import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { LMApiProvider, lmKeysService, type LmApiKeyValidation } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, Check, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { TONE } from '@src/components/llm-endpoints/tone';
import { useStatusRecord } from '@src/components/status/use-status-record';
import { notify } from '@src/notifications';

import { providerLabel } from './provider-label';

function invalidateFundingFacts(): void {
  void lazyAssets.invalidate(LazyAsset.Status);
  void lazyAssets.invalidate(LazyAsset.LlmFunding);
}

export function LlmKeysSection() {
  const { t } = useLingui();
  const { status: record } = useStatusRecord();
  // The slots ARE the keyable providers: the backend lists exactly the ones a key can be stored
  // for, so the select and the list below cannot disagree.
  const slots = record?.keys ?? [];
  const allProviders = slots.map((k) => k.provider);
  const [picked, setProvider] = useState<string | null>(null);
  const provider = picked ?? allProviders[0] ?? '';
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Per-provider validity: undefined = untested this session.
  const [validity, setValidity] = useState<Record<string, LmApiKeyValidation | undefined>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const onSave = async () => {
    if (!value.trim() || !provider) return;
    setBusy(true);
    try {
      const res = await lmKeysService.setLmApi(value.trim(), provider as LMApiProvider);
      setValue('');
      setValidity((v) => ({ ...v, [provider]: { valid: res.valid, message: res.message } }));
      invalidateFundingFacts();
      if (res.valid) notify.success({ title: t`Key saved & valid`, message: providerLabel(provider) });
      else notify.error({ title: t`Key saved but invalid`, message: res.message ?? providerLabel(provider) });
    } catch (error) {
      notify.error({ title: t`Error`, message: error instanceof Error ? error.message : t`Failed to save key` });
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (p: string) => {
    setTesting(p);
    try {
      const res = await lmKeysService.testLmApi(p as LMApiProvider);
      setValidity((v) => ({ ...v, [p]: res }));
    } catch {
      setValidity((v) => ({ ...v, [p]: { valid: false, message: t`Test failed` } }));
    } finally {
      setTesting(null);
    }
  };

  const onDelete = async (p: string) => {
    await lmKeysService.deleteLmApi(p as LMApiProvider);
    setValidity((v) => ({ ...v, [p]: undefined }));
    invalidateFundingFacts();
  };

  return (
    <section className="flex flex-col gap-3" data-testid="llm-sources-keys">
      <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <KeyRound className="h-3 w-3" />
        <Trans>API keys on this machine</Trans>
      </h2>

      <div className="flex gap-2">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="h-10 w-[140px]" data-testid="keys-provider-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allProviders.map((p) => (
              <SelectItem key={p} value={p}>
                {providerLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onSave()}
          placeholder={t`Paste API key`}
          className="h-10"
          data-testid="keys-input"
        />
        <Button disabled={busy || !value.trim()} onClick={() => void onSave()} data-testid="keys-save">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Save</Trans>}
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {slots.map((k) => {
          const v = validity[k.provider];
          return (
            <li
              key={k.provider}
              data-testid={`keys-row-${k.provider}`}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${k.stored ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                <span className="font-medium">{providerLabel(k.provider)}</span>
                {k.stored ? (
                  <span className="font-mono text-xs text-muted-foreground" data-testid={`keys-hint-${k.provider}`}>
                    {k.hint || t`stored`}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    <Trans>not set</Trans>
                  </span>
                )}
                {v && (
                  <Badge variant="outline" className={`gap-1 ${v.valid ? TONE.emerald : TONE.destructive}`}>
                    {v.valid ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                    {v.valid ? <Trans>Valid</Trans> : <Trans>Invalid</Trans>}
                  </Badge>
                )}
              </span>
              {k.stored && (
                <span className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    disabled={testing === k.provider}
                    data-testid={`keys-test-${k.provider}`}
                    onClick={() => void onTest(k.provider)}
                  >
                    {testing === k.provider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trans>Test</Trans>}
                  </Button>
                  <button
                    type="button"
                    aria-label={t`Delete key`}
                    data-testid={`keys-delete-${k.provider}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmDelete(k.provider)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={t`Delete this key?`}
        description={t`The stored API key for this provider is removed from this machine. You can add it again later.`}
        onConfirm={() => {
          if (confirmDelete) void onDelete(confirmDelete);
          setConfirmDelete(null);
        }}
      />
    </section>
  );
}
