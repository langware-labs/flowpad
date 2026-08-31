import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Switch } from '@src/components/ui/switch';
import { SearchCalibration } from '@src/hooks/use-record-search';
import { X } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

/** The BM25 column-weight vector, exactly as `SearchCalibration.col_weights` declares it. */
type ColWeights = NonNullable<SearchCalibration['col_weights']>;

const KNOWN_TYPES = ['skill', 'bookmark', 'claude_session', 'agentic_process', 'snippet', 'note'];

interface SearchCalibrationPanelProps {
  calibration: SearchCalibration;
  onChange: (c: SearchCalibration) => void;
  latencyMs?: number | null;
}

export function SearchCalibrationPanel({ calibration, onChange, latencyMs }: SearchCalibrationPanelProps) {
  // Six values, in the FTS column order [entity_id, type, name, title,
  // description, content]. Not four: `sqlite_driver.py:672` applies the vector
  // only `if cal.col_weights and len(cal.col_weights) == 6`, so the 4-value
  // array this panel used to build was discarded server-side — toggling Column
  // Weights on did nothing at all, and the 4th input was labelled `content`
  // while it actually edited `title`.
  const col_weights: ColWeights = calibration.col_weights ?? [0, 0, 10, 8, 3, 1];
  const colWeightsEnabled = !!calibration.col_weights;
  const recencyBoostEnabled = calibration.recency_boost != null;
  const recencyBoost = calibration.recency_boost ?? 0.01;
  const recencyFactorEnabled = calibration.recency_factor != null;
  const recencyFactor = calibration.recency_factor ?? 0.02;
  const overfetchEnabled = calibration.overfetch != null;
  const overfetch = calibration.overfetch ?? 10;
  const type_scores = calibration.type_scores ?? {};

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-muted-foreground">
          <Trans>Search Calibration</Trans>
        </span>
        <div className="flex items-center gap-2">
          {latencyMs != null && (
            <span className="text-xs text-muted-foreground">
              <Trans>⚡ {latencyMs} ms</Trans>
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => onChange({ ...calibration, visible: false })}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Recency Factor (Python-side blend) */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id="recency-factor-toggle"
            checked={recencyFactorEnabled}
            onCheckedChange={(checked) => {
              onChange({ ...calibration, recency_factor: checked ? recencyFactor : undefined });
            }}
          />
          <Label htmlFor="recency-factor-toggle" className="font-medium">
            <Trans>Recency Factor (k)</Trans>
          </Label>
        </div>
        {recencyFactorEnabled && (
          <div className="flex items-center gap-3 ps-8">
            <Input
              type="number"
              step="0.005"
              min="0"
              value={recencyFactor}
              onChange={(e) => {
                onChange({ ...calibration, recency_factor: parseFloat(e.target.value) || undefined });
              }}
              className="h-7 w-28 text-xs"
            />
            <span className="text-xs text-muted-foreground">
              <Trans>bm25 / (1 + days × k)</Trans>
            </span>
          </div>
        )}
      </div>

      {/* Overfetch */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id="overfetch-toggle"
            checked={overfetchEnabled}
            onCheckedChange={(checked) => {
              onChange({ ...calibration, overfetch: checked ? overfetch : undefined });
            }}
          />
          <Label htmlFor="overfetch-toggle" className="font-medium">
            <Trans>Overfetch</Trans>
          </Label>
        </div>
        {overfetchEnabled && (
          <div className="flex items-center gap-3 ps-8">
            <Input
              type="number"
              step="5"
              min="0"
              value={overfetch}
              onChange={(e) => {
                onChange({ ...calibration, overfetch: parseInt(e.target.value) || undefined });
              }}
              className="h-7 w-28 text-xs"
            />
            <span className="text-xs text-muted-foreground">
              <Trans>extra rows fetched (limit + overfetch)</Trans>
            </span>
          </div>
        )}
      </div>

      {/* Column Weights */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id="col-weights-toggle"
            checked={colWeightsEnabled}
            onCheckedChange={(checked) => {
              onChange({
                ...calibration,
                col_weights: checked ? ([...col_weights] as ColWeights) : undefined,
              });
            }}
          />
          <Label htmlFor="col-weights-toggle" className="font-medium">
            <Trans>Column Weights</Trans>
          </Label>
        </div>
        {colWeightsEnabled && (
          <div className="grid grid-cols-3 gap-2 ps-8">
            {(['entity_id', 'type', 'name', 'title', 'description', 'content'] as const).map((label, i) => (
              <div key={label} className="space-y-1">
                <Label className="text-xs text-muted-foreground">{label}</Label>
                <Input
                  type="number"
                  step="0.5"
                  disabled={i < 2}
                  value={col_weights[i]}
                  onChange={(e) => {
                    const w = [...col_weights] as ColWeights;
                    w[i] = parseFloat(e.target.value) || 0;
                    onChange({ ...calibration, col_weights: w });
                  }}
                  className="h-7 text-xs"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recency Boost */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id="recency-toggle"
            checked={recencyBoostEnabled}
            onCheckedChange={(checked) => {
              onChange({ ...calibration, recency_boost: checked ? recencyBoost : undefined });
            }}
          />
          <Label htmlFor="recency-toggle" className="font-medium">
            <Trans>Recency Boost</Trans>
          </Label>
        </div>
        {recencyBoostEnabled && (
          <div className="ps-8">
            <Input
              type="number"
              step="0.001"
              min="0"
              value={recencyBoost}
              onChange={(e) => {
                onChange({ ...calibration, recency_boost: parseFloat(e.target.value) || undefined });
              }}
              className="h-7 w-32 text-xs"
            />
          </div>
        )}
      </div>

      {/* Type Scores */}
      <div className="space-y-2">
        <Label className="font-medium">
          <Trans>Type Scores</Trans>
        </Label>
        <div className="grid grid-cols-3 gap-2">
          {KNOWN_TYPES.map((t) => (
            <div key={t} className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t}</Label>
              <Input
                type="number"
                step="0.5"
                value={type_scores[t] ?? 0}
                onChange={(e) => {
                  const val = parseFloat(e.target.value) || 0;
                  const next = { ...type_scores };
                  if (val === 0) delete next[t];
                  else next[t] = val;
                  onChange({ ...calibration, type_scores: Object.keys(next).length ? next : undefined });
                }}
                className="h-7 text-xs"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
