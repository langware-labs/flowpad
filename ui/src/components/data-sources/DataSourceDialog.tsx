/**
 * Add or edit a source. One form, because the fields are identical and a
 * separate editor would be the same code with a different verb on the button.
 *
 * What it deliberately does NOT write: `kind` and `channel`. `sync_source`
 * (flow_sdk/ingest/sync.py) writes both from the driver on the first poll, so a
 * value set here would look authoritative, be owned by nobody, and get silently
 * corrected later. For the agent transport the channel IS `config.connector`,
 * which the form does set — through the field that owns it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Agent, DataSource, type SourceStatus } from '@sdk';
import type { TypeId } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { lucideByName } from '@src/lib/lucide-by-name';
import { useAllocateAgentMailbox } from '@src/hooks/use-allocate-agent-mailbox';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Dialog } from '@src/components/ui/dialog';
import { SteppedDialogContent, type StepCrumb } from '@src/components/ui/stepped-dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { SetupWizardPanel } from '@src/components/setup-wizard/SetupWizardDialog';
import { GroupChoice } from './GroupChoice';
import {
  accountKeyFor,
  buildConfig,
  emptyDraft,
  fieldRules,
  fieldValue,
  pickedFrom,
  pickedIn,
  specFields,
  setUpByWizard,
  validateDraft,
  type SourceDraft,
} from './source-form';
import { ChoiceField } from './ChoiceField';
import { sourceIconName } from './source-icon';
import { DesktopTile, TILE_TIP_DELAY, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { useSourceSpecs } from './use-source-specs';
import { FieldType, type DataSourceChoice, type DataDriver, type SpecConfigField } from '@sdk';

/**
 * The switch's boolean → a lifecycle status.
 *
 * Un-pausing does NOT mean "active": a Slack source that was paused mid-setup
 * must go back to needing its invite, not skip it. So it returns to `new` and
 * lets the backend re-resolve — the one place that knows which drivers verify.
 */
function statusFor(enabled: boolean, current: SourceStatus): SourceStatus {
  if (!enabled) return 'disabled';
  return current === 'disabled' ? 'new' : current;
}

/** The one config-shaped field that is NOT stored in `config` — it is the
 *  entity's own `allowed_senders`. Named once here so the seed, the
 *  submit-time extraction and the pre-fill all agree on the reserved key. */
const ALLOWED_SENDERS_KEY = 'allowed_senders';

function draftFrom(source: DataSource, spec?: DataDriver): SourceDraft {
  const fields: Record<string, string> = {};
  const picked: Record<string, DataSourceChoice[]> = {};
  for (const [key, field] of specFields(spec)) {
    // `allowed_senders` reads the real entity field, never `config` — it was
    // never written there (see `submit`'s extraction below).
    const raw = key === ALLOWED_SENDERS_KEY ? { [key]: source.allowed_senders } : (source.config ?? {});
    fields[key] = fieldValue(key, field, raw);
    if (field.choices) picked[key] = pickedFrom(key, field, raw);
  }
  return {
    name: source.name,
    provider: source.provider,
    account_key: source.account_key,
    // The switch is "not paused", which is NOT "active": a source still in
    // `setup` is unpaused and deliberately not running. Mapping it back through
    // a boolean is why the toggle cannot resolve the lifecycle itself — see
    // `statusFor`.
    enabled: source.status !== 'disabled',
    poll_interval_seconds: source.poll_interval_seconds,
    window_days: source.window_days,
    thread_timeout_seconds: source.thread_timeout_seconds,
    fields,
    picked,
  };
}

export function DataSourceDialog({
  open,
  onOpenChange,
  editing,
  owner,
  only,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the form edits this source instead of creating one. */
  editing?: DataSource | null;
  /** Who the new source belongs to (a user or an agent). Omitted → the backend
   *  stamps the local user, so every existing caller is unchanged. */
  owner?: TypeId | null;
  /** Narrow the provider tiles — the channels line offers only specs that
   *  `sends`. An empty result renders as a sentence, not a blank picker. */
  only?: (spec: DataDriver) => boolean;
}) {
  const { t } = useLingui();
  // Whatever is INSTALLED, not a hardcoded list: a source added as an asset
  // shows up here with no frontend release.
  const { specs: installed, specFor } = useSourceSpecs();
  const allocateMailbox = useAllocateAgentMailbox();
  // A source is an asset: it is saved into the project open here (an agent's into the agent's project).
  const { project } = useDataContext();
  const ownerAgentId = owner?.type === Agent.type ? owner.id : null;
  // An unlisted provider is never offered (a vendor the cloud stands in front of), and one
  // the cloud provisions is an agent's own account — offered only when adding for an agent.
  const offered = installed.filter((s) => s.listed && (!s.provisioned || ownerAgentId));
  const specs = only ? offered.filter(only) : offered;
  const [draft, setDraft] = useState<SourceDraft>(() => emptyDraft());
  const [showAdvanced, setShowAdvanced] = useState(false);
  // A driver group being chosen ("WhatsApp"): its setup phase shows a card per way to connect.
  const [group, setGroup] = useState('');
  // Where the person is: each step REPLACES the body (``SteppedDialogContent``) — the provider grid, a group's
  // ways to connect, the chosen provider's form — and the setup that follows is one more step after them.
  const [step, setStep] = useState<'provider' | 'choice' | 'form'>('provider');
  // Nothing is wrong with a form nobody has filled in yet. Problems are shown once the person
  // asks to add the source — before that the red box reads as a broken dialog, not as guidance.
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Seed the form once per opening, keyed on WHAT is being edited. `specFor`
  // changes identity on every live `DataDriver` emission, and depending on it
  // re-seeded the draft mid-typing — discarding whatever had been entered. It is
  // read through a ref so the seed still sees the current one without
  // subscribing the effect to it.
  const seedRef = useRef(specFor);
  seedRef.current = specFor;
  useEffect(() => {
    if (!open) return;
    setDraft(editing ? draftFrom(editing, seedRef.current(editing.provider)) : emptyDraft());
    setGroup('');
    setStep(editing ? 'form' : 'provider');
    setShowAdvanced(false);
    setTried(false);
  }, [open, editing]);

  const spec = specFor(draft.provider);
  // One tile per driver group (its first member stands for it), one per ungrouped driver.
  const tiles = specs.filter((p) => !p.group || groupMembers(specs, p.group)[0]?.name === p.name);
  // The agent the cloud creates this account for — no form, nothing to validate. The
  // picker only offers a provisioned provider with an agent owner, so this is that agent.
  const provisioned = !editing && spec?.provisioned ? ownerAgentId : null;
  // The wizard asks for this driver's config — the form asks only for a name, then hands over.
  const byWizard = setUpByWizard(spec, !!editing);
  const [settingUp, setSettingUp] = useState<DataSource | null>(null);
  const problems = useMemo(
    () => (provisioned ? [] : validateDraft(draft, spec, { config: !byWizard })),
    [provisioned, draft, spec, byWizard],
  );

  const setField = (key: string, value: string) =>
    // Typing into a choosable field drops its picks: the two inputs are never both
    // authoritative, and `buildConfig` prefers a pick — so a stale one would silently
    // beat what the person just typed.
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value }, picked: { ...d.picked, [key]: [] } }));

  const setPicked = (key: string, choices: DataSourceChoice[]) =>
    setDraft((d) => ({ ...d, picked: { ...d.picked, [key]: choices } }));

  const submit = async () => {
    if (problems.length) return;
    setBusy(true);
    try {
      if (provisioned) {
        // The one provisioned account today is the agent's mailbox; allocating wires
        // the local source itself.
        if (await allocateMailbox(new Agent({ id: provisioned }))) {
          notify.success({ title: t`${spec?.title} is ready` });
          onOpenChange(false);
        }
        return;
      }
      const config = buildConfig(draft, spec);
      // `allowed_senders` shares the manifest-driven field/picker machinery
      // (so a provider that offers it gets the same picker-or-type UX as any
      // other choosable field, with no bespoke render code) but it is NOT a
      // `config` entry — it is the entity's own `allowed_senders`.
      // Pull it back out here, the one place a manifest field's destination
      // can differ from `config`.
      const allowedSenders = Array.isArray(config[ALLOWED_SENDERS_KEY])
        ? (config[ALLOWED_SENDERS_KEY] as string[])
        : [];
      delete config[ALLOWED_SENDERS_KEY];
      const account = accountKeyFor(draft, spec);
      if (editing) {
        const nextName = draft.name.trim();
        const nextStatus = statusFor(draft.enabled, editing.status);
        const changed =
          editing.name !== nextName ||
          editing.status !== nextStatus ||
          editing.account_key !== account ||
          JSON.stringify(editing.config ?? {}) !== JSON.stringify(config) ||
          editing.poll_interval_seconds !== draft.poll_interval_seconds ||
          editing.window_days !== draft.window_days ||
          editing.thread_timeout_seconds !== draft.thread_timeout_seconds ||
          JSON.stringify(editing.allowed_senders ?? []) !== JSON.stringify(allowedSenders);
        editing.name = nextName;
        editing.status = nextStatus;
        editing.account_key = account;
        editing.config = config;
        editing.poll_interval_seconds = draft.poll_interval_seconds;
        editing.window_days = draft.window_days;
        editing.thread_timeout_seconds = draft.thread_timeout_seconds;
        editing.allowed_senders = allowedSenders;
        await editing.save();
        if (changed) editing.markEdit();
        notify.success({ title: t`Updated ${editing.name}` });
      } else {
        const source = new DataSource({
          name: draft.name.trim(),
          provider: draft.provider,
          account_key: account,
          config,
          // 'new' on purpose: the backend resolves it to `setup` or `active`
          // depending on whether the driver has a verification step, and only
          // it knows which drivers do.
          status: draft.enabled ? 'new' : 'disabled',
          poll_interval_seconds: draft.poll_interval_seconds,
          window_days: draft.window_days,
          thread_timeout_seconds: draft.thread_timeout_seconds,
          owner: owner ? owner.toString() : null,
          allowed_senders: allowedSenders,
        });
        await source.save(project?.typeId && !ownerAgentId ? [project.typeId] : []);
        notify.success({ title: t`Added ${source.name}` });
        if (byWizard) {
          setSettingUp(source); // the form gives way to the setup wizard; closing that closes both
          return;
        }
      }
      onOpenChange(false);
    } catch (e) {
      notify.error({ title: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Built once per render, not once per choosable field: `buildConfig` walks the whole
  // spec, so asking it per field rebuilt every other field's value too.
  const draftConfig = useMemo(() => buildConfig(draft, spec), [draft, spec]);

  const renderField = ([key, field]: [string, SpecConfigField]) => {
    const value = draft.fields[key] ?? '';
    const input =
      field.type === FieldType.LINES ? (
        <Textarea
          id={`ds-${key}`}
          rows={3}
          value={value}
          placeholder={field.placeholder || undefined}
          onChange={(e) => setField(key, e.target.value)}
        />
      ) : (
        <Input
          id={`ds-${key}`}
          type={field.type === FieldType.NUMBER ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder || undefined}
          onChange={(e) => setField(key, e.target.value)}
        />
      );
    return (
      <div key={key} className="space-y-1">
        <Label htmlFor={`ds-${key}`}>
          {field.label || key}
          {fieldRules(spec, key).required && <span className="ms-1 text-destructive">*</span>}
        </Label>
        {/* A choosable field hands its own input over as the fallback, so the picker and
            the text box are one decision made in one place rather than two branches here
            that could both be true. */}
        {field.choices ? (
          <ChoiceField
            fieldKey={key}
            field={field}
            provider={draft.provider}
            config={draftConfig}
            picked={pickedIn(draft, key, field)}
            onPicked={(choices) => setPicked(key, choices)}
            fallback={input}
          />
        ) : (
          input
        )}
        {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
      </div>
    );
  };

  const close = () => {
    setSettingUp(null);
    onOpenChange(false);
  };
  const toProviders = () => {
    setStep('provider');
    setGroup('');
    setDraft(emptyDraft());
    setTried(false);
  };
  const toChoice = () => {
    setStep('choice');
    setDraft(emptyDraft());
    setTried(false);
  };
  // The trail: where the person is, and how they got there. Once the source exists (its setup is running) the
  // way back is closed — going back would add it a second time.
  const beforeSetup = !settingUp;
  const crumbs: StepCrumb[] = [
    {
      label: editing ? t`Edit data source` : only ? t`Add a channel` : t`Data sources`,
      onClick: !editing && beforeSetup && step !== 'provider' ? toProviders : undefined,
    },
  ];
  if (group && step !== 'provider')
    crumbs.push({ label: group, onClick: beforeSetup && step === 'form' ? toChoice : undefined });
  // Never an empty crumb: the driver may not be known (yet) — the source's own name stands in.
  const formCrumb = editing ? editing.name : spec?.title || draft.provider || settingUp?.name || '';
  if ((step === 'form' || settingUp) && formCrumb) crumbs.push({ label: formCrumb });
  if (settingUp) crumbs.push({ label: t`Connect` });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <SteppedDialogContent
        ref={contentRef}
        crumbs={crumbs}
        description={
          step === 'provider' && beforeSetup ? (
            only ? (
              <Trans>Where people reach this agent — one number, mailbox or chat per channel.</Trans>
            ) : (
              <Trans>
                A source is one remote stream — one feed, channel, drive or mailbox. The poller syncs it on the
                heartbeat.
              </Trans>
            )
          ) : undefined
        }
        // Every provider tile is a tooltip trigger, and a tooltip opens on focus: auto-focusing
        // the first tile popped its description over the row below it, where it sat on top of
        // the tiles a person was about to click. The dialog itself takes focus instead.
        onOpenAutoFocus={(e) => {
          if (editing) return;
          e.preventDefault();
          contentRef.current?.focus();
        }}
        footer={
          settingUp ? (
            <Button variant="ghost" onClick={close} data-testid="ds-setup-close">
              <Trans>Close</Trans>
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                <Trans>Cancel</Trans>
              </Button>
              {step === 'form' && (
                <Button
                  onClick={() => {
                    setTried(true);
                    void submit();
                  }}
                  disabled={busy}
                >
                  {busy
                    ? '…'
                    : editing
                      ? t`Save`
                      : provisioned
                        ? t`Create ${spec?.title}`
                        : byWizard && group
                          ? t`Connect ${group}`
                          : byWizard
                            ? t`Add and set up`
                            : t`Add source`}
                </Button>
              )}
            </>
          )
        }
      >
        {settingUp ? (
          <SetupWizardPanel source={settingUp} autoStart />
        ) : step === 'provider' ? (
          <TileSection title={<Trans>Provider</Trans>}>
            {specs.length === 0 && (
              <p className="text-xs text-muted-foreground">
                <Trans>No installed provider can carry a channel.</Trans>
              </p>
            )}
            {tiles.map((p) => {
              // Through the one source→glyph rule, so the tile a person picks and the
              // card it becomes cannot disagree. No channel here: a provider is being
              // chosen, not one of a multi-channel transport's channels.
              // A group's tile is the choice ("WhatsApp"), so it shows the group's own glyph, not its first member's.
              const groupIcon = p.group
                ? groupMembers(specs, p.group).find((m) => m.group_icon_name)?.group_icon_name
                : '';
              const Glyph = lucideByName(groupIcon || sourceIconName(p, null));
              const label = p.group || p.title || p.name || '';
              const chosen = p.group ? group === p.group : draft.provider === p.name;
              return (
                <Tooltip key={p.name} delayDuration={TILE_TIP_DELAY}>
                  <TooltipTrigger asChild>
                    <DesktopTile
                      data-testid={p.group ? `provider-group-${p.group}` : `provider-${p.name}`}
                      Icon={Glyph}
                      label={label}
                      onClick={() => {
                        // A group's tile opens its ways to connect; any other tile, its form.
                        setGroup(p.group || '');
                        setDraft(p.group ? emptyDraft() : emptyDraft(p));
                        setStep(p.group ? 'choice' : 'form');
                      }}
                      className={cn(chosen && 'border-primary bg-accent text-foreground ring-1 ring-primary')}
                    />
                  </TooltipTrigger>
                  {/* What the tile used to spell out underneath. A 10px line
                        of body copy per provider made the grid a wall of text
                        to read before you could pick anything; the sentence is
                        still one hover away, where it answers a question you
                        actually have. */}
                  <TooltipContent side="bottom" className="max-w-[16rem]">
                    <span className="font-medium">{label}</span>
                    {p.description && <span className="mt-0.5 block opacity-90">{p.description}</span>}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </TileSection>
        ) : step === 'choice' ? (
          <GroupChoice
            group={group}
            members={groupMembers(specs, group)}
            selected={draft.provider}
            onPick={(m) => {
              setDraft(emptyDraft(m));
              setStep('form');
            }}
          />
        ) : (
          <div className="space-y-4">
            {!editing && !draft.provider ? null : provisioned ? (
              <p className="text-sm text-muted-foreground" data-testid="provisioned-source-note">
                {spec?.description}
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="ds-name">
                    <Trans>Data source name</Trans>
                    <span className="ms-1 text-destructive">*</span>
                  </Label>
                  <Input
                    id="ds-name"
                    value={draft.name}
                    placeholder={spec?.title || undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </div>

                {byWizard ? (
                  <p
                    className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground"
                    data-testid="ds-by-wizard"
                  >
                    <Trans>A guided setup asks for everything else this channel needs, step by step.</Trans>
                  </p>
                ) : (
                  specFields(spec)
                    .filter(([, f]) => !f.advanced)
                    .map(renderField)
                )}

                <div className="flex items-center justify-between rounded border p-2">
                  <Label htmlFor="ds-enabled" className="text-sm">
                    <Trans>Enabled</Trans>
                  </Label>
                  <Switch
                    id="ds-enabled"
                    checked={draft.enabled}
                    onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
                  />
                </div>

                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? t`Hide advanced` : t`Advanced`}
                </button>

                {showAdvanced && (
                  <div className="space-y-3 rounded border p-3">
                    <div className="space-y-1">
                      <Label htmlFor="ds-interval">
                        <Trans>Poll interval (seconds)</Trans>
                      </Label>
                      <Input
                        id="ds-interval"
                        type="number"
                        min={60}
                        value={draft.poll_interval_seconds}
                        onChange={(e) => setDraft((d) => ({ ...d, poll_interval_seconds: Number(e.target.value) }))}
                      />
                      <p className="text-xs text-muted-foreground">
                        <Trans>Minimum 60 — the heartbeat only ticks once a minute.</Trans>
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="ds-window">
                        <Trans>Window (days)</Trans>
                      </Label>
                      <Input
                        id="ds-window"
                        type="number"
                        min={1}
                        value={draft.window_days}
                        onChange={(e) => setDraft((d) => ({ ...d, window_days: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="ds-thread-timeout">
                        <Trans>Thread timeout (minutes)</Trans>
                      </Label>
                      <Input
                        id="ds-thread-timeout"
                        type="number"
                        min={1}
                        value={draft.thread_timeout_seconds === null ? '' : draft.thread_timeout_seconds / 60}
                        placeholder={t`never`}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            thread_timeout_seconds:
                              e.target.value === '' ? null : Math.round(Number(e.target.value) * 60),
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        <Trans>A thread quiet this long ends; the next message starts a new one. Empty — never.</Trans>
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="ds-account">
                        <Trans>Account key</Trans>
                      </Label>
                      <Input
                        id="ds-account"
                        value={draft.account_key}
                        placeholder={accountKeyFor(draft) || t`derived from the fields above`}
                        onChange={(e) => setDraft((d) => ({ ...d, account_key: e.target.value }))}
                      />
                      <p className="text-xs text-muted-foreground">
                        <Trans>This source&apos;s remote identity — one source per account.</Trans>
                      </p>
                    </div>
                    {!byWizard &&
                      specFields(spec)
                        .filter(([, f]) => f.advanced)
                        .map(renderField)}
                  </div>
                )}
              </>
            )}

            {tried && problems.length > 0 && (
              <ul className="space-y-1 rounded bg-destructive/10 p-2 text-xs text-destructive">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SteppedDialogContent>
    </Dialog>
  );
}

/** A group's members, in their declared order (``group_order``, then title). */
function groupMembers(specs: DataDriver[], group: string): DataDriver[] {
  return specs
    .filter((s) => s.group === group)
    .sort((a, b) => (a.group_order ?? 0) - (b.group_order ?? 0) || (a.title || '').localeCompare(b.title || ''));
}
