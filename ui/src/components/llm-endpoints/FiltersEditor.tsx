/**
 * The narrowing filters of an endpoint, as a form. Down a chain filters can only
 * narrow, so every field here reads as "at most" / "only these" — the hub
 * rejects a save that widens past a source's effective filters, and the
 * dialog surfaces that message verbatim.
 */
import { Trans, useLingui } from '@lingui/react/macro';

import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';

import { AliasesEditor } from './AliasesEditor';
import { STREAMING_POLICIES, type FiltersForm } from './filters-limits-forms';

export interface FiltersEditorProps {
  value: FiltersForm;
  onChange: (next: FiltersForm) => void;
  disabled?: boolean;
}

export function FiltersEditor({ value, onChange, disabled }: FiltersEditorProps) {
  const { t } = useLingui();
  const set = <K extends keyof FiltersForm>(key: K, v: FiltersForm[K]) => onChange({ ...value, [key]: v });

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
            rows={3}
            value={value.models_allow}
            disabled={disabled}
            placeholder={'anthropic/claude-*\nopenai/gpt-4*'}
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
