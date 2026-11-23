/**
 * The fields of the endpoint dialog that only an API endpoint has, drawn with the dialog's own
 * controls: what a root serves (where an LLM root picks its provider), the header its key is sent
 * in, what a call costs (where an LLM root lists its models), and which paths pass.
 */
import { Trans, useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Textarea } from '@src/components/ui/textarea';

import { API_KINDS, kindsOf, type ApiDraft, type PriceRuleRow } from './api-endpoint-draft';

interface FieldProps {
  value: ApiDraft;
  onChange: (next: ApiDraft) => void;
  disabled?: boolean;
}

const TILE = 'rounded border p-2 text-start text-xs disabled:opacity-60';

/** What the root serves: one tile per known kind, or a typed one. */
export function ApiServesField({ value, onChange, disabled }: FieldProps) {
  const { t } = useLingui();
  const kinds = kindsOf(value.kinds);
  const known = API_KINDS.find((kind) => kinds.length === 1 && kinds[0] === kind.id);
  return (
    <div className="space-y-1" data-testid="api-serves">
      <Label>
        <Trans>Serves</Trans>
      </Label>
      <div className="grid grid-cols-3 gap-2">
        {API_KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            data-testid={`api-kind-${kind.id}`}
            disabled={disabled}
            onClick={() => onChange({ ...value, kinds: kind.id })}
            className={`${TILE} ${known?.id === kind.id ? 'border-primary bg-primary/5' : 'border-border'}`}
          >
            <span className="block font-medium">{t(kind.label)}</span>
            <span className="block truncate text-muted-foreground">{kind.id}</span>
          </button>
        ))}
        <button
          type="button"
          data-testid="api-kind-other"
          disabled={disabled}
          onClick={() => onChange({ ...value, kinds: '' })}
          className={`${TILE} ${known ? 'border-border' : 'border-primary bg-primary/5'}`}
        >
          <span className="block font-medium">
            <Trans>Other</Trans>
          </span>
          <span className="block truncate text-muted-foreground">
            <Trans>any HTTP API</Trans>
          </span>
        </button>
      </div>
      {!known && (
        <Input
          data-testid="api-kinds"
          value={value.kinds}
          disabled={disabled}
          placeholder={t`What it serves, e.g. speech.generate (optional)`}
          onChange={(e) => onChange({ ...value, kinds: e.target.value })}
        />
      )}
    </div>
  );
}

/** Where the key goes in a forwarded request. Fixed once created, like the base URL. */
export function ApiKeyHeaderField({ value, onChange, disabled }: FieldProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label htmlFor="api-key-header">
          <Trans>Key header</Trans>
        </Label>
        <Input
          id="api-key-header"
          data-testid="api-key-header"
          autoComplete="off"
          value={value.header}
          disabled={disabled}
          placeholder="authorization"
          onChange={(e) => onChange({ ...value, header: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="api-key-format">
          <Trans>Key format</Trans>
        </Label>
        <Input
          id="api-key-format"
          data-testid="api-key-format"
          autoComplete="off"
          value={value.format}
          disabled={disabled}
          placeholder="Bearer {value}"
          onChange={(e) => onChange({ ...value, format: e.target.value })}
        />
      </div>
    </div>
  );
}

const EMPTY_ROW: PriceRuleRow = { path: '', usd: '', times: '' };

/** What a call costs: one row per path. The first row that matches a call prices it. */
export function ApiPricesField({ value, onChange, disabled }: FieldProps) {
  const { t } = useLingui();
  if (value.meterKind === 'json_usage') {
    return (
      <div className="space-y-1.5" data-testid="price-rules">
        <Label>
          <Trans>Prices</Trans>
        </Label>
        <p className="text-xs text-muted-foreground">
          <Trans>This root is priced by the tokens each answer reports. That is set through the API, not here.</Trans>
        </p>
      </div>
    );
  }
  const rows = value.prices.length ? value.prices : [EMPTY_ROW];
  const setRow = (index: number, patch: Partial<PriceRuleRow>) =>
    onChange({ ...value, prices: rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  return (
    <div className="space-y-1.5" data-testid="price-rules">
      <Label>
        <Trans>Prices</Trans>
      </Label>
      <div className="grid items-center gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) 4.5rem 11rem 2rem' }}>
        <span className="text-xs text-muted-foreground">
          <Trans>Call (path)</Trans>
        </span>
        <span className="text-xs text-muted-foreground">
          <Trans>USD</Trans>
        </span>
        <span className="text-xs text-muted-foreground">
          <Trans>Times (request field)</Trans>
        </span>
        <span />
        {rows.map((row, i) => (
          // Rows have no identity but their position.
          <div key={i} className="contents" data-testid="price-rule">
            <Input
              className="font-mono"
              value={row.path}
              disabled={disabled}
              placeholder="models/*:generate"
              aria-label={t`Call (path)`}
              onChange={(e) => setRow(i, { path: e.target.value })}
            />
            <Input
              className="font-mono"
              type="number"
              min={0}
              step="0.001"
              inputMode="decimal"
              value={row.usd}
              disabled={disabled}
              placeholder="0"
              aria-label={t`USD`}
              onChange={(e) => setRow(i, { usd: e.target.value })}
            />
            <Input
              className="font-mono"
              value={row.times}
              disabled={disabled}
              placeholder={t`once`}
              aria-label={t`Times (request field)`}
              onChange={(e) => setRow(i, { times: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label={t`Remove`}
              disabled={disabled}
              onClick={() => onChange({ ...value, prices: rows.filter((_, at) => at !== i) })}
            >
              ×
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={disabled}
        data-testid="price-rule-add"
        onClick={() => onChange({ ...value, prices: [...rows, EMPTY_ROW] })}
      >
        <Trans>Add row</Trans>
      </Button>
      <p className="text-xs text-muted-foreground">
        <Trans>
          A call that matches no row is free. A call is booked when its answer is delivered. Times multiplies the price
          by a number in the request, e.g. parameters.durationSeconds=8 (8 when the request does not say).
        </Trans>
      </p>
    </div>
  );
}

/** An API endpoint's filters: which sub paths and methods pass. Down a chain they only narrow. */
export function ApiFiltersFields({ value, onChange, disabled }: FieldProps) {
  const { t } = useLingui();
  return (
    <div className="space-y-3" data-testid="filters-editor">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="api-paths">
            <Trans>Paths allowed (globs)</Trans>
          </Label>
          <Textarea
            id="api-paths"
            data-testid="api-paths"
            rows={3}
            className="font-mono text-xs"
            value={value.paths}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, paths: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>One per line. Empty means everything the sources allow.</Trans>
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="api-methods">
            <Trans>Methods allowed</Trans>
          </Label>
          <Textarea
            id="api-methods"
            data-testid="api-methods"
            rows={3}
            className="font-mono text-xs"
            value={value.methods}
            disabled={disabled}
            placeholder={'GET\nPOST'}
            onChange={(e) => onChange({ ...value, methods: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>One per line. Empty means every method.</Trans>
          </p>
        </div>
      </div>
    </div>
  );
}
