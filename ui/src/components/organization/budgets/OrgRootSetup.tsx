/**
 * Making the organization the paying entity on its own provider key.
 *
 * Two states, driven by `OrgScopeBudget.is_root`/`credential_hint`, not by local state — a refetch
 * (another admin finished setup, a key was replaced elsewhere) must move this forward on its own:
 *
 * * **No pool yet:** pick a provider, paste a key, Activate. Two hub calls in sequence — create
 *   the org's root (`setupOrgRoot`), then store the key on the id that call returns
 *   (`setCredential`). If the second call fails, the root now exists with no key; the component
 *   re-renders into the "has a root, no key yet" state on its own once the mutation's invalidate
 *   lands, and `CredentialField` picks up from there — nothing is lost, there is no partial state
 *   to reconcile by hand.
 * * **Has a root:** `CredentialField` in its normal "endpoint exists" mode — Save/Test/Delete
 *   against the real id. Provider is shown but not editable; `provider`/`base_url` are immutable
 *   on the hub once a root is spending traffic.
 *
 * A pool that already exists as a CHAIN (the older "draw from Flowpad's shared root" flow, still
 * reachable from `/dock/hub/token-plan`) gets neither state: converting a chain into a root in
 * place is not offered, so this renders a plain notice instead of a form nothing can submit.
 */
import { llmEndpointsService, type OrgScopeBudget } from '@sdk';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { CredentialField } from '@src/components/llm-endpoints/CredentialField';
import { PROVIDERS, type ProviderSpec } from '@src/components/llm-endpoints/endpoint-catalog';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { useSetupOrgRoot } from './use-budgets';

export interface OrgRootSetupProps {
  orgId: string;
  org: Pick<OrgScopeBudget, 'endpoint_id' | 'is_root' | 'provider' | 'credential_hint'>;
}

export function OrgRootSetup({ orgId, org }: OrgRootSetupProps) {
  if (org.endpoint_id && !org.is_root) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="org-root-legacy-chain">
        <Trans>
          This organization draws its budget from Flowpad's shared pool. Bringing your own key isn't offered for an
          organization already set up this way.
        </Trans>
      </p>
    );
  }

  if (org.endpoint_id && org.is_root) {
    return (
      <OrgKeyField endpointId={org.endpoint_id} provider={org.provider} credentialHint={org.credential_hint ?? ''} />
    );
  }

  return <OrgKeyCreateForm orgId={orgId} />;
}

/** Provider + key entry when the org has no pool yet. One submit, two hub calls. */
function OrgKeyCreateForm({ orgId }: { orgId: string }) {
  const { t } = useLingui();
  const [providerId, setProviderId] = useState<ProviderSpec['id']>(PROVIDERS[0].id);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = useSetupOrgRoot();
  const spec = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];

  const submit = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    try {
      const created = await setup.mutateAsync({ orgId, provider: providerId, baseUrl: spec.defaultBaseUrl });
      try {
        await llmEndpointsService.setCredential(created.endpoint_id, key.trim());
        notify.success({
          title: t`Organization activated`,
          message: t`Spending now bills your own ${spec.label}.`,
          id: 'org-root',
        });
        setKey('');
      } catch (e) {
        // The root exists; only the key failed to store. Say so distinctly — a plain "could not
        // create" would send the admin back to re-submit a provider choice that already landed.
        notify.error({
          title: t`Organization created, but the key was not saved`,
          message: errorMessage(e, t`Paste it again below.`),
          id: 'org-root',
        });
      }
    } catch (e) {
      notify.error({ title: t`Could not activate the organization`, message: errorMessage(e, ''), id: 'org-root' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3" data-testid="org-root-setup">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <KeyRound className="h-3.5 w-3.5" />
        <Trans>Bring your own key</Trans>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>
          This organization spends against its own provider key. Everything you allocate to teams and people below draws
          on it.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="radiogroup" aria-label={t`Provider`}>
          {PROVIDERS.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="sm"
              variant={p.id === providerId ? 'default' : 'outline'}
              aria-pressed={p.id === providerId}
              data-testid={`org-root-provider-${p.id}`}
              onClick={() => setProviderId(p.id)}
              disabled={busy}
            >
              {t(p.label)}
            </Button>
          ))}
        </div>
        <div className="min-w-56 flex-1">
          <CredentialField value={key} onChange={setKey} placeholder={spec.keyPlaceholder} disabled={busy} />
        </div>
        <Button size="sm" disabled={busy || !key.trim()} onClick={() => void submit()} data-testid="org-root-activate">
          {busy ? '…' : t`Activate`}
        </Button>
      </div>
    </div>
  );
}

/** The org already has a root: an ordinary `CredentialField` against the real id, so Save/Test/
 *  Delete are the SAME code path the expert LLM Endpoints page already ships and tests. */
function OrgKeyField({
  endpointId,
  provider,
  credentialHint,
}: {
  endpointId: string;
  provider: string | null;
  credentialHint: string;
}) {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  const [hint, setHint] = useState(credentialHint);
  const spec = provider ? PROVIDERS.find((p) => p.id === provider) : undefined;
  return (
    <div className="flex items-center gap-3" data-testid="org-root-key">
      {spec && <span className="text-xs text-muted-foreground">{t(spec.label)}</span>}
      <div className="min-w-56 flex-1">
        <CredentialField
          endpointId={endpointId}
          credentialHint={hint}
          value={value}
          onChange={setValue}
          onStored={setHint}
        />
      </div>
    </div>
  );
}
