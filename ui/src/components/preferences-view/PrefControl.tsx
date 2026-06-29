import { PrefDataType, PrefInfo, PrefOption, soundService } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { Label } from '@src/components/ui/label';
import { Switch } from '@src/components/ui/switch';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { NOTIFICATION_SOUNDS } from '@src/assets/sounds/notification/manifest';
import { Play } from 'lucide-react';
import { ReactNode, useEffect, useMemo, useState } from 'react';

/**
 * Resolve a pref's selectable options. Static `options` win; `optionsSource`
 * pulls a ui-layer list (e.g. the Vite-glob notification-sound manifest, which
 * can't live in the SDK) and carries a previewUrl for the play affordance.
 */
function resolveOptions(info: PrefInfo): PrefOption[] {
  if (info.options) return info.options;
  if (info.optionsSource === 'notification_sounds') {
    return NOTIFICATION_SOUNDS.map((s) => ({ value: s.key, label: s.displayName, previewUrl: s.url }));
  }
  return [];
}

/** Label + description block — the "content" half of a settings row. */
function RowHeader({ id, info }: { id: string; info: PrefInfo }) {
  return (
    <div className="min-w-0">
      <Label htmlFor={id} className="cursor-pointer text-sm font-medium text-foreground">
        {info.label}
      </Label>
      {info.description && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{info.description}</p>
      )}
    </div>
  );
}

/**
 * A settings row. By default the control sits in a tight right column beside its
 * label (toggles, selects, numbers); `block` stacks a full-width control under the
 * label (multi-line JSON). The whole row shares one hover surface so the control
 * always reads as belonging to its label.
 */
function PrefRow({
  block = false,
  header,
  control,
}: {
  block?: boolean;
  header: ReactNode;
  control: ReactNode;
}) {
  if (block) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-muted/30">
        {header}
        {control}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4 transition-colors hover:bg-muted/30">
      {header}
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}

/**
 * A single registry-driven preference control. Renders the right input for the
 * pref's `dataType` and reads/writes the value via {@link usePreference}.
 */
export function PrefControl({ info }: { info: PrefInfo }) {
  const [value, setValue] = usePreference<unknown>(info.key);
  const id = `pref-${info.key}`;
  const header = <RowHeader id={id} info={info} />;

  switch (info.dataType) {
    case PrefDataType.BOOL:
      return (
        <PrefRow
          header={header}
          control={
            <Switch
              id={id}
              checked={value === true}
              onCheckedChange={(checked) => setValue(checked === true)}
            />
          }
        />
      );

    case PrefDataType.STRING: {
      // dataType STRING ⇒ the stored value is a string (coerced by the store).
      const strValue = (value ?? '') as string;
      const options = resolveOptions(info);
      const control =
        options.length > 0 ? (
          <SelectControl id={id} options={options} value={strValue} onChange={setValue} />
        ) : (
          <Input
            id={id}
            value={strValue}
            onChange={(e) => setValue(e.target.value)}
            className="h-9 w-56"
          />
        );
      return <PrefRow header={header} control={control} />;
    }

    case PrefDataType.NUMBER:
      return (
        <PrefRow
          header={header}
          control={
            <Input
              id={id}
              type="number"
              value={Number(value ?? 0)}
              onChange={(e) => setValue(e.target.value === '' ? 0 : Number(e.target.value))}
              className="h-9 w-28 text-right tabular-nums"
            />
          }
        />
      );

    case PrefDataType.JSON:
      return (
        <PrefRow block header={header} control={<JsonControl id={id} value={value} onChange={setValue} />} />
      );

    default:
      return null;
  }
}

/** Select with an optional per-option audio preview button. Sits in the right column. */
function SelectControl({
  id,
  options,
  value,
  onChange,
}: {
  id: string;
  options: PrefOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const hasPreview = options.some((o) => o.previewUrl);
  return (
    <div className="flex items-center gap-1.5">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9 w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasPreview && (
        <button
          type="button"
          onClick={() => {
            const url = options.find((o) => o.value === value)?.previewUrl;
            if (url) void soundService.play(url);
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
          title="Preview"
          aria-label="Preview sound"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * JSON textarea. Edits stay local until they parse; invalid JSON shows an inline
 * error and does NOT write (so the store never holds an unparseable value).
 */
function JsonControl({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const serialized = useMemo(() => JSON.stringify(value ?? null, null, 2), [value]);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the draft when the stored value changes externally (e.g. reload).
  useEffect(() => {
    setDraft(serialized);
    setError(null);
  }, [serialized]);

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        id={id}
        value={draft}
        rows={6}
        className={`font-mono text-xs leading-relaxed ${error ? 'border-red-500/60 focus-visible:ring-red-500/40' : ''}`}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          try {
            const parsed = JSON.parse(text);
            setError(null);
            onChange(parsed);
          } catch {
            setError('Invalid JSON — not saved');
          }
        }}
      />
      {error && <span className="text-xs font-medium text-red-500">{error}</span>}
    </div>
  );
}
