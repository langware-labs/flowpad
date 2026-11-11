/**
 * Which model this endpoint serves for each size (sm / md / lg).
 *
 * A worker asks for a SIZE; the endpoint answers with the model set here, or — when a size is left on
 * "Inherit" — the one the next endpoint up the chain sets. The inherited value is shown beside the
 * choice so "Inherit" is never a blank: you see the model you will actually get and who chose it.
 * The hub refuses a model the chain cannot serve (outside an ancestor's allowed list or the root's
 * catalog); the dialog surfaces that message verbatim.
 */
import { LLM_MODEL_SIZES, type LLMChainTier, type LLMEndpointTiers, type LLMModelSize } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { Label } from '@src/components/ui/label';

export interface TiersEditorProps {
  value: LLMEndpointTiers;
  onChange: (next: LLMEndpointTiers) => void;
  /** Models the endpoint may name (its allowed catalog), offered in each picker. */
  models: readonly string[];
  /** What each size resolves to down the chain today, for the "Inherit" label. */
  effective?: Partial<Record<LLMModelSize, LLMChainTier>>;
  disabled?: boolean;
}

const INHERIT = '';

export function TiersEditor({ value, onChange, models, effective, disabled }: TiersEditorProps) {
  const { t } = useLingui();
  const label: Record<LLMModelSize, string> = { sm: t`Small`, md: t`Medium`, lg: t`Large` };

  return (
    <div className="space-y-2" data-testid="tiers-editor">
      {LLM_MODEL_SIZES.map((size) => {
        const own = value[size];
        const inherited = effective?.[size];
        // A model set here that the catalog no longer lists stays selectable, so opening the dialog
        // never silently rewrites a saved value.
        const options = own && !models.includes(own) ? [own, ...models] : models;
        return (
          <div key={size} className="grid grid-cols-[6rem_1fr] items-center gap-2">
            <Label htmlFor={`tier-${size}`} className="text-xs">
              {label[size]} <span className="text-muted-foreground">({size})</span>
            </Label>
            <div className="space-y-0.5">
              <select
                id={`tier-${size}`}
                data-testid={`tier-${size}`}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                value={own ?? INHERIT}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, [size]: e.target.value || null })}
              >
                <option value={INHERIT}>{t`Inherit`}</option>
                {options.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              {!own && (
                <p className="text-[11px] text-muted-foreground" data-testid={`tier-${size}-inherited`}>
                  {inherited?.model ? (
                    <Trans>Inherits {inherited.model}</Trans>
                  ) : (
                    (inherited?.reason ?? <Trans>No model declared up the chain</Trans>)
                  )}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
