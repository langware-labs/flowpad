/**
 * Making the organization the paying entity on its own provider key.
 *
 * Two states, driven by `OrgScopeBudget.is_root`/`credential_hint`, not by local state — a refetch
 * (another admin finished setup, a key was replaced elsewhere) must move this forward on its own:
 *
 * * **No pool yet:** pick a provider, paste a key, Activate. Two hub calls in sequence — create
 *   the org's root (`setPayingProvider`), then store the key on the id that call returns
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
 *
 * **Both `endpoint_id`s go through `endpointIdFromTypeId` first.** The budgets action answers with
 * a PREFIXED typeid (`llm_endpoint-<uuid>`, from `str(pool.typeid)`), while the credential calls
 * build `new TypeId('llm_endpoint', id)` and so want the BARE uuid. Handing the prefixed form
 * straight through makes that constructor throw synchronously, inside the service call and before
 * any HTTP: no request is ever sent, Save looks like a dead button and Test reports `Invalid (0)`
 * out of its own catch. The create flow failed the same way one step later — the root was created
 * and the key then thrown away — which is how an org ends up `is_root` with an empty
 * `credential_hint`. Every other consumer on this page (`setLifetimeCap`, `EndpointControls`,
 * `addOne`) already converts; this one is not special.
 */
import { TypeId, dataManager, llmEndpointsService, type OrgScopeBudget } from '@sdk';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useLingui as useLinguiCore } from '@lingui/react';
import { Trans, useLingui } from '@lingui/react/macro';

import { CredentialField } from '@src/components/llm-endpoints/CredentialField';
import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import {
  PROVIDERS,
  isProvider,
  keyShapeProblem,
  providerSpec,
  type ProviderSpec,
} from '@src/components/llm-endpoints/endpoint-catalog';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { useInvalidateBudgets, useSetPayingProvider } from './use-budgets';

export interface PayingProviderSetupProps {
  orgId: string;
  org: Pick<
    OrgScopeBudget,
    'endpoint_id' | 'is_root' | 'provider' | 'credential_hint' | 'can_set_credential' | 'can_set_up_budget'
  >;
}

export function PayingProviderSetup({ orgId, org }: PayingProviderSetupProps) {
  // NO POOL YET -- and this branch must be judged on `can_set_up_budget`, not on
  // `can_set_credential`. The latter is the `credential` question asked of the POOL, so an
  // organization that has none answers false for EVERYONE, its owner included: gating here on it
  // told the owner of a brand new org "its owner sets one up" and gave them no way to be that
  // owner. The right question is asked of the organization, and it is answerable before setup.
  if (!org.endpoint_id) {
    return org.can_set_up_budget ? <OrgKeyCreateForm orgId={orgId} /> : <PayingProviderSummary org={org} />;
  }

  // Same statement of fact for everyone: bringing a key is not offered on a pool that already
  // draws from the shared one, whoever is asking.
  if (!org.is_root) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="org-root-legacy-chain">
        <Trans>
          This organization draws its budget from Flowpad's shared pool. Bringing your own key isn't offered for an
          organization already set up this way.
        </Trans>
      </p>
    );
  }

  // A root exists. Whose key it holds is the OWNER's answer, so an admin gets a statement of fact
  // instead of the field -- shown rather than hidden, because an admin dividing this money needs to
  // know which provider it runs on and that a key is in place, or a provider refusal is unreadable
  // to them. The last four characters are all a hint ever contains.
  return org.can_set_credential ? (
    <OrgKeyField
      endpointId={endpointIdFromTypeId(org.endpoint_id)}
      provider={org.provider}
      credentialHint={org.credential_hint ?? ''}
    />
  ) : (
    <PayingProviderSummary org={org} />
  );
}

/** What an admin sees where the owner sees the key form: the provider, and whether a key is set. */
function PayingProviderSummary({ org }: Pick<PayingProviderSetupProps, 'org'>) {
  const { t } = useLingui();
  const spec = org.provider ? providerSpec(org.provider) : undefined;
  const providerLabel = spec ? t(spec.label) : '';
  if (!org.endpoint_id) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="org-root-owner-only">
        <Trans>This organization has no budget yet. Its owner sets one up.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="org-root-owner-only">
      <p>
        {providerLabel ? (
          <Trans>This organization pays on its own {providerLabel} key.</Trans>
        ) : (
          <Trans>This organization pays on its own provider key.</Trans>
        )}
      </p>
      <p data-testid="org-root-hint">
        {org.credential_hint ? (
          <Trans>Key ending {org.credential_hint} — only the owner can change it.</Trans>
        ) : (
          <Trans>No key has been set yet. Its owner sets one.</Trans>
        )}
      </p>
    </div>
  );
}

/**
 * The provider control. Editable while the org has no pool; shown and disabled once a root exists,
 * because the hub refuses to change `provider`/`base_url` on an endpoint that already exists
 * (`buildEntityJson` omits both when editing). Hiding it there would answer "which provider is
 * this org on?" with nothing; a live dropdown would be a form that lies. Disabled says both.
 */
function ProviderSelect({
  value,
  onChange,
  disabled,
  locked,
}: {
  value: string | null;
  onChange?: (next: ProviderSpec['id']) => void;
  disabled?: boolean;
  locked?: boolean;
}) {
  const { t } = useLingui();
  return (
    <Select
      value={value ?? undefined}
      onValueChange={(v) => isProvider(v) && onChange?.(v)}
      disabled={disabled || locked}
    >
      <SelectTrigger
        className="w-40"
        aria-label={t`Provider`}
        title={locked ? t`The provider cannot be changed once the budget exists.` : undefined}
        data-testid="org-root-provider"
      >
        <SelectValue placeholder={t`Provider`} />
      </SelectTrigger>
      <SelectContent>
        {PROVIDERS.map((p) => (
          <SelectItem key={p.id} value={p.id} data-testid={`org-root-provider-${p.id}`}>
            {t(p.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Provider + key entry when the org has no pool yet. One submit, two hub calls. */
function OrgKeyCreateForm({ orgId }: { orgId: string }) {
  const { t } = useLingui();
  const { i18n } = useLinguiCore();
  const [providerId, setProviderId] = useState<ProviderSpec['id']>(PROVIDERS[0].id);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = useSetPayingProvider();
  const spec = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];

  const submit = async () => {
    if (!key.trim() || busy) return;
    // Checked BEFORE the root is created. This flow's two calls are ordered create-then-store, so
    // letting a visibly wrong key through would leave behind exactly what it cannot undo: a root
    // with no usable credential.
    const badShape = keyShapeProblem(providerId, key);
    if (badShape) {
      notify.error({ title: t`That key does not look right`, message: i18n._(badShape), id: 'org-root' });
      return;
    }
    setBusy(true);
    try {
      const created = await setup.mutateAsync({ orgId, provider: providerId, baseUrl: spec.defaultBaseUrl });
      try {
        await llmEndpointsService.setCredential(endpointIdFromTypeId(created.endpoint_id), key.trim());
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
        <ProviderSelect value={providerId} onChange={setProviderId} disabled={busy} />
        <div className="min-w-56 flex-1">
          <CredentialField
            provider={providerId}
            value={key}
            onChange={setKey}
            placeholder={spec.keyPlaceholder}
            disabled={busy}
          />
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
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [removing, setRemoving] = useState(false);
  const invalidate = useInvalidateBudgets();

  // Switching provider means DELETING this root and building another, because `provider` and
  // `base_url` sit in the hub's `_immutable_update` list. Removing the stored key does not do it —
  // that clears the credential and leaves the endpoint, which is why a key delete appears to change
  // nothing about the locked dropdown. This is the control that actually does.
  const replace = async () => {
    setRemoving(true);
    try {
      await dataManager.delete(new TypeId('llm_endpoint', endpointId));
      await invalidate();
      notify.success({
        title: t`Budget removed`,
        message: t`Pick a provider and paste a key to set it up again.`,
        id: 'org-root',
      });
    } catch (e) {
      notify.error({ title: t`Could not remove the budget`, message: errorMessage(e, ''), id: 'org-root' });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="org-root-key">
      <div className="flex items-center gap-3">
        <ProviderSelect value={provider} locked />
        <div className="min-w-56 flex-1">
          <CredentialField
            endpointId={endpointId}
            provider={provider}
            credentialHint={hint}
            value={value}
            onChange={setValue}
            onStored={setHint}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>The provider is fixed once a budget exists.</Trans>{' '}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-xs"
          disabled={removing}
          data-testid="org-root-replace"
          onClick={() => setConfirmReplace(true)}
        >
          <Trans>Use a different provider</Trans>
        </Button>
      </p>

      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        variant="destructive"
        title={t`Remove this budget and start again?`}
        description={t`The organization's budget and its stored key are deleted, and every team drawing on it stops spending until a new one is set up. Allocations already given to teams and people are not refunded — they will point at a budget that no longer exists.`}
        confirmLabel={t`Remove budget`}
        onConfirm={() => void replace()}
      />
    </div>
  );
}
