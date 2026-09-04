/**
 * "Does a call through this endpoint actually succeed?" — one row, one answer.
 *
 * The hub's `test` action sends ONE minimal completion down the resolved chain,
 * so the verdict covers the credential, every hop's filters and budget, the
 * routing and the provider itself. That is why this sits on EVERY row and not
 * only on roots: an allocation holds no credential of its own, so the
 * credential probe in the edit dialog (`CredentialField`) refuses it outright
 * and can never answer the question for the rows people mostly have.
 *
 * A refused or failed call is a verdict, not an error: it renders as a red
 * status here rather than as a toast.
 *
 * TWO transports, one button. On the hub the `test` action is addressed directly
 * (`/graph/llm_endpoint/<id>/test`); on a box that path is a 404, because the type has no
 * local rows — there the same action is reached through the `llm-endpoint` box action,
 * which already carries the listing. The verdict shape is identical either way, so every
 * surface renders one button and never has to know which runtime it is on.
 */
import { isHubOnly, llmEndpointsService, llmSourcesService, type LLMEndpointTestResult } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { Check, Loader2, X, Zap } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';

export interface TestEndpointButtonProps {
  endpointId: string;
}

export function TestEndpointButton({ endpointId }: TestEndpointButtonProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<LLMEndpointTestResult | null>(null);

  const run = async () => {
    setBusy(true);
    setVerdict(null);
    try {
      setVerdict(
        isHubOnly() ? await llmEndpointsService.testEndpoint(endpointId) : await llmSourcesService.test(endpointId),
      );
    } catch (e) {
      // Only a transport/permission failure lands here — the hub answers a
      // refused call inside a success envelope.
      setVerdict({ ok: false, status: 0, model: '', latency_ms: 0, message: errorMessage(e, t`Test failed`) });
    } finally {
      setBusy(false);
    }
  };

  const title = !verdict
    ? t`Send one minimal call through this endpoint`
    : verdict.ok
      ? t`${verdict.status} · ${verdict.model} · ${verdict.latency_ms}ms`
      : `${verdict.status || ''} ${verdict.message}`.trim();

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-7 w-auto gap-1 px-1.5 ${verdict ? (verdict.ok ? 'text-emerald-600' : 'text-destructive') : ''}`}
      aria-label={t`Test`}
      title={title}
      disabled={busy}
      data-testid={`llm-test-${endpointId}`}
      onClick={() => void run()}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : verdict?.ok ? (
        <Check className="h-3.5 w-3.5" />
      ) : verdict ? (
        <X className="h-3.5 w-3.5" />
      ) : (
        <Zap className="h-3.5 w-3.5" />
      )}
      {verdict && !busy && (
        <span className="font-mono text-[11px]" data-testid={`llm-test-verdict-${endpointId}`}>
          {verdict.ok ? `${verdict.latency_ms}ms` : verdict.status || t`failed`}
        </span>
      )}
    </Button>
  );
}
