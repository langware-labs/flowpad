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
 * **The MODEL is on the face of the button, not only in the tooltip.** Which model answered is
 * the interesting half of a successful probe: an endpoint's allowed list is walked cheapest-first
 * (`_probe_candidates`), so the tick alone does not say whether the call landed on the cheap model
 * the wallet was capped for or on something further down the list. The latency stays beside it,
 * dimmed — it is the number nobody has to read. A long provider-qualified id is truncated rather
 * than shortened by hand: the full string is in the tooltip, and mangling a model name is how a
 * reader ends up unsure which one it actually was.
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
  /** Told the verdict as it lands (null while a run is in flight), so a surface can say what
   *  the call actually spent underneath the tick — see `FundingProvenance`. The button keeps
   *  owning its own state; this only mirrors it outward. */
  onVerdict?: (verdict: LLMEndpointTestResult | null) => void;
  /**
   * Render the verdict text beside the icon? Default yes.
   *
   * `false` leaves the button as the icon alone, for a surface that draws the verdict itself
   * somewhere the button cannot reach — the budgets row anchors it over that row's model list, so
   * a result never changes the row's height. Such a caller takes the verdict through `onVerdict`;
   * the button still owns its own state and its own colour.
   */
  inlineVerdict?: boolean;
}

export function TestEndpointButton({ endpointId, onVerdict, inlineVerdict = true }: TestEndpointButtonProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<LLMEndpointTestResult | null>(null);

  const announce = (next: LLMEndpointTestResult | null) => {
    setVerdict(next);
    onVerdict?.(next);
  };

  const run = async () => {
    setBusy(true);
    announce(null);
    try {
      announce(
        isHubOnly() ? await llmEndpointsService.testEndpoint(endpointId) : await llmSourcesService.test(endpointId),
      );
    } catch (e) {
      // Only a transport/permission failure lands here — the hub answers a
      // refused call inside a success envelope.
      announce({ ok: false, status: 0, model: '', latency_ms: 0, message: errorMessage(e, t`Test failed`) });
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
      {verdict && !busy && inlineVerdict && (
        <span
          className="inline-flex min-w-0 items-baseline gap-1 font-mono text-[11px]"
          data-testid={`llm-test-verdict-${endpointId}`}
        >
          {verdict.ok ? (
            <>
              {/* Empty on the transport-failure path this component builds itself, and on a hub
                  verdict that never reached a model — so the latency is never left orphaned. */}
              {verdict.model && (
                <span
                  className="max-w-[9rem] truncate"
                  title={verdict.model}
                  data-testid={`llm-test-model-${endpointId}`}
                >
                  {verdict.model}
                </span>
              )}
              <span className="text-muted-foreground">{verdict.latency_ms}ms</span>
            </>
          ) : (
            verdict.status || t`failed`
          )}
        </span>
      )}
    </Button>
  );
}
