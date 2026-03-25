import type { SettingsField, Scope } from './settings-utils';
import { ScopeBadge } from './ScopeBadge';
import { cn } from '@src/lib/utils';

interface SettingsFieldRowProps {
  field: SettingsField;
  showOverrides: boolean;
  highlighted?: boolean;
}

export function SettingsFieldRow({ field, showOverrides, highlighted }: SettingsFieldRowProps) {
  const hasOverrides =
    (field.projectValue !== undefined && field.scope !== 'project') ||
    (field.localValue !== undefined && field.scope !== 'local') ||
    (field.userValue !== undefined && field.scope !== 'user' && (field.projectValue !== undefined || field.localValue !== undefined));

  return (
    <div className={cn('py-2', highlighted && 'rounded bg-accent/50')}>
      <div className="flex items-start gap-3">
        {/* Label + description */}
        <div className="min-w-[180px] shrink-0">
          <div>
            <span className="text-sm font-medium text-foreground">{field.label}</span>
            <span className="ml-1.5 text-[11px] text-muted-foreground/60">{field.key}</span>
          </div>
          {field.description && (
            <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground/70">{field.description}</p>
          )}
          {field.allowedValues && field.allowedValues.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {field.allowedValues.map((v) => (
                <span
                  key={v}
                  className="inline-flex rounded border border-muted px-1 py-px text-[10px] font-mono text-muted-foreground/70"
                >
                  {v}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Value */}
        <div className="min-w-0 flex-1">
          <ValueDisplay value={field.effectiveValue} fieldType={field.fieldType} />
        </div>

        {/* Scope badge */}
        <div className="shrink-0">
          <ScopeBadge scope={field.scope} />
        </div>
      </div>

      {/* Override annotations */}
      {showOverrides && hasOverrides && (
        <div className="ml-[180px] mt-1 space-y-0.5 pl-3 border-l-2 border-muted">
          {field.userValue !== undefined && field.scope !== 'user' && (
            <OverrideRow scope="user" value={field.userValue} fieldType={field.fieldType} />
          )}
          {field.projectValue !== undefined && field.scope !== 'project' && (
            <OverrideRow scope="project" value={field.projectValue} fieldType={field.fieldType} />
          )}
          {field.localValue !== undefined && field.scope !== 'local' && (
            <OverrideRow scope="local" value={field.localValue} fieldType={field.fieldType} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Value display ───────────────────────────────────────

function stringifyPrimitive(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v.toString();
  return JSON.stringify(v) ?? '';
}

function ValueDisplay({ value, fieldType }: { value: unknown; fieldType: string }) {
  if (value === undefined || value === null) {
    return <span className="text-sm italic text-muted-foreground/50">(not set)</span>;
  }

  if (fieldType === 'boolean' && typeof value === 'boolean') {
    return (
      <span className={cn('text-sm font-mono', value ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}>
        {value.toString()}
      </span>
    );
  }

  if (fieldType === 'string' && typeof value === 'string') {
    if (!value) return <span className="text-sm italic text-muted-foreground/50">(not set)</span>;
    return <span className="text-sm font-mono text-foreground">{value}</span>;
  }

  if (fieldType === 'number' && typeof value === 'number') {
    return <span className="text-sm font-mono text-foreground">{value.toString()}</span>;
  }

  if (fieldType === 'string[]' && Array.isArray(value)) {
    const arr = value as string[];
    if (arr.length === 0) {
      return <span className="text-sm italic text-muted-foreground/50">(empty)</span>;
    }
    return (
      <div className="flex flex-wrap gap-1">
        {arr.map((item, i) => (
          <span
            key={i}
            className="inline-flex rounded bg-secondary px-1.5 py-0.5 text-xs font-mono text-secondary-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    );
  }

  if (fieldType === 'dict' && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) {
      return <span className="text-sm italic text-muted-foreground/50">(empty)</span>;
    }
    return (
      <div className="flex flex-wrap gap-1">
        {entries.slice(0, 8).map(([k, v]) => (
          <span
            key={k}
            className="inline-flex rounded bg-secondary px-1.5 py-0.5 text-xs font-mono text-secondary-foreground"
          >
            {k}={stringifyPrimitive(v)}
          </span>
        ))}
        {entries.length > 8 && (
          <span className="text-xs text-muted-foreground">+{entries.length - 8} more</span>
        )}
      </div>
    );
  }

  // object — compact JSON preview
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return <span className="text-sm italic text-muted-foreground/50">(empty)</span>;
    }
    return (
      <span className="text-sm text-muted-foreground">
        {keys.length} {keys.length === 1 ? 'entry' : 'entries'}
      </span>
    );
  }

  return <span className="text-sm font-mono text-foreground">{stringifyPrimitive(value)}</span>;
}

// ── Override annotation row ─────────────────────────────

function OverrideRow({ scope, value, fieldType }: { scope: Scope; value: unknown; fieldType: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="select-none">&#8627;</span>
      <ValueDisplay value={value} fieldType={fieldType} />
      <ScopeBadge scope={scope} />
    </div>
  );
}
