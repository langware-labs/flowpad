/**
 * The narrowing filters of an endpoint, as a form. Down a chain filters can only
 * narrow, so every field here reads as "at most" / "only these" — the hub
 * rejects a save that widens past a source's effective filters, and the
 * dialog surfaces that message verbatim.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useRef } from 'react';

import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';

import { AliasesEditor } from './AliasesEditor';
import { STREAMING_POLICIES, type FiltersForm } from './filters-limits-forms';

/**
 * The globs offered when `Models allowed` is empty — a starting point to edit, not a default.
 *
 * `anthropic/claude-*` is what a Claude Code harness routed through the hub actually sends:
 * `CLAUDE_API_AUTH_SPEC.tier_models` stamps OpenRouter slugs (`anthropic/claude-haiku-4.5`,
 * `-sonnet-4.5`, `-opus-4.1`) onto argv before spawn, so one glob covers every tier.
 */
const MODELS_ALLOW_EXAMPLE = 'anthropic/claude-*\nopenai/gpt-4*';

export interface FiltersEditorProps {
  value: FiltersForm;
  onChange: (next: FiltersForm) => void;
  disabled?: boolean;
}

export function FiltersEditor({ value, onChange, disabled }: FiltersEditorProps) {
  const { t } = useLingui();
  const set = <K extends keyof FiltersForm>(key: K, v: FiltersForm[K]) => onChange({ ...value, [key]: v });

  const modelsAllowRef = useRef<HTMLTextAreaElement>(null);

  // An EDITABLE placeholder: a real `placeholder` vanishes the moment you type, which is the
  // wrong affordance for a syntax you are meant to copy and adjust. The example is written into
  // the field when an empty one is focused, and taken back on blur if it was left exactly as
  // offered — because empty MEANS something here ("everything the sources allow"), so tabbing
  // through the form must never leave a filter nobody typed.
  const seedModelsAllow = () => {
    if (value.models_allow !== '') return;
    set('models_allow', MODELS_ALLOW_EXAMPLE);
    // The seeded value only lands on the next render; move the caret to the end once it has, so
    // typing extends the example rather than inserting in front of it.
    requestAnimationFrame(() => {
      const el = modelsAllowRef.current;
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const clearUntouchedModelsAllow = () => {
    if (value.models_allow === MODELS_ALLOW_EXAMPLE) set('models_allow', '');
  };

  const numeric = (
    key: 'max_tokens_ceiling' | 'max_input_chars' | 'temperature_max' | 'top_p_max',
    label: string,
    step = '1',
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`llm-f-${key}`}>{label}</Label>
      <Input
        id={`llm-f-${key}`}
        type="number"
        min={0}
        step={step}
        inputMode="decimal"
        value={value[key]}
        disabled={disabled}
        placeholder={t`no ceiling`}
        onChange={(e) => set(key, e.target.value)}
      />
    </div>
  );

  return (
    <div className="space-y-3" data-testid="filters-editor">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="llm-f-models_allow">
            <Trans>Models allowed (globs)</Trans>
          </Label>
          <Textarea
            id="llm-f-models_allow"
            ref={modelsAllowRef}
            rows={3}
            value={value.models_allow}
            disabled={disabled}
            placeholder={MODELS_ALLOW_EXAMPLE}
            onFocus={seedModelsAllow}
            onBlur={clearUntouchedModelsAllow}
            onChange={(e) => set('models_allow', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>One per line. Empty means everything the sources allow.</Trans>
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="llm-f-models_deny">
            <Trans>Models denied (globs)</Trans>
          </Label>
          <Textarea
            id="llm-f-models_deny"
            rows={3}
            value={value.models_deny}
            disabled={disabled}
            onChange={(e) => set('models_deny', e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {numeric('max_tokens_ceiling', t`Max tokens`)}
        {numeric('max_input_chars', t`Max input chars`)}
        {numeric('temperature_max', t`Temperature ≤`, '0.1')}
        {numeric('top_p_max', t`Top-p ≤`, '0.05')}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="llm-f-streaming">
            <Trans>Streaming</Trans>
          </Label>
          <select
            id="llm-f-streaming"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={value.streaming}
            disabled={disabled}
            onChange={(e) => set('streaming', e.target.value as FiltersForm['streaming'])}
          >
            {STREAMING_POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="llm-f-paths_allow">
            <Trans>Paths allowed (globs)</Trans>
          </Label>
          <Textarea
            id="llm-f-paths_allow"
            rows={2}
            value={value.paths_allow}
            disabled={disabled}
            placeholder={'v1/**'}
            onChange={(e) => set('paths_allow', e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1 rounded border border-border/60 p-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="llm-f-betas-restricted" className="text-sm">
            <Trans>Restrict beta headers</Trans>
          </Label>
          <Switch
            id="llm-f-betas-restricted"
            checked={value.betasRestricted}
            disabled={disabled}
            onCheckedChange={(v) => set('betasRestricted', v)}
          />
        </div>
        {value.betasRestricted && (
          <Textarea
            id="llm-f-betas_allow"
            rows={2}
            aria-label={t`Betas allowed`}
            value={value.betas_allow}
            disabled={disabled}
            placeholder={'prompt-caching-2024-07-31'}
            onChange={(e) => set('betas_allow', e.target.value)}
          />
        )}
      </div>

      <AliasesEditor
        title={t`Aliases (client name → real model)`}
        rows={value.aliases}
        disabled={disabled}
        onChange={(rows) => set('aliases', rows)}
        testId="aliases-editor"
      />
      <AliasesEditor
        title={t`Model map (rewrite before forwarding)`}
        rows={value.model_map}
        disabled={disabled}
        onChange={(rows) => set('model_map', rows)}
        testId="model-map-editor"
      />
    </div>
  );
}
