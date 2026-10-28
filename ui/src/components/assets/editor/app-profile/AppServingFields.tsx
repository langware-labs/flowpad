import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import { notify } from '@src/notifications';
import { Input } from '@src/components/ui/input';
import { Switch } from '@src/components/ui/switch';
import { cn } from '@src/lib/utils';

import { declaredPort, withPort, type ProxyServing } from './app-fields';

const FIELD_LABEL = 'mb-1 text-xs text-muted-foreground';
/** Written literally in a start command; a variable, so the message catalog does not read it as a placeholder. */
const PORT_TOKEN = '{port}';

/** A labelled field: the small muted label above its control, as the agent editor lays them out. */
export function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className={FIELD_LABEL}>{label}</div>
      {children}
    </div>
  );
}

/** A text field that edits locally and commits on blur — only when it changed, so blur is cheap. */
export function CommitInput({
  value,
  onCommit,
  isValid,
  mono = true,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  /** A value it refuses snaps back to the saved one; the caller says why. */
  isValid?: (value: string) => boolean;
  mono?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next === value) return;
    if (isValid && !isValid(next)) return setDraft(value);
    onCommit(next);
  };
  return (
    <Input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      className={cn(mono && 'font-mono', props.className)}
    />
  );
}

interface ProxyFieldsProps {
  serving: ProxyServing;
  onChange: (next: ProxyServing) => void;
  testId: string;
}

/** Run a command: what starts it, the port it is served on, its health path, and install & build. */
export function ProxyFields({ serving, onChange, testId }: ProxyFieldsProps) {
  const { t } = useLingui();
  const port = declaredPort(serving);
  const set = (patch: Partial<ProxyServing>) => onChange({ ...serving, ...patch });

  return (
    <div className="space-y-3" data-testid={testId}>
      <Field label={<Trans>Start command</Trans>}>
        <CommitInput
          value={serving.start_cmd ?? ''}
          onCommit={(v) => set({ start_cmd: v })}
          placeholder="npm run dev -- --port {port}"
          aria-label={t`Start command`}
          data-testid={`${testId}-start`}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          <Trans>
            <code className="rounded bg-muted px-1 font-mono">{PORT_TOKEN}</code> is the port it is started on.
          </Trans>
        </p>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={<Trans>Port</Trans>}>
          <CommitInput
            value={port ? String(port.port) : ''}
            inputMode="numeric"
            placeholder={t`any free port`}
            aria-label={t`Port`}
            data-testid={`${testId}-port`}
            isValid={(v) => {
              const n = Number(v);
              if (!v || (Number.isInteger(n) && n >= 1 && n <= 65535)) return true;
              notify.error({ title: t`Not a port`, message: t`A port is a whole number from 1 to 65535.` });
              return false;
            }}
            onCommit={(v) =>
              onChange(withPort(serving, v ? { port: Number(v), required: port?.required ?? false } : null))
            }
          />
        </Field>
        <Field label={<Trans>Health check</Trans>}>
          <CommitInput
            value={serving.health ?? '/'}
            onCommit={(v) => set({ health: v || '/' })}
            aria-label={t`Health check`}
            data-testid={`${testId}-health`}
          />
        </Field>
      </div>
      {port && (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm">
              <Trans>Only this port</Trans>
            </span>
            <Switch
              checked={port.required !== false}
              onCheckedChange={(v) => onChange(withPort(serving, { port: port.port, required: v }))}
              aria-label={t`Only this port`}
              data-testid={`${testId}-required`}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {port.required !== false
              ? t`On: if another program holds ${port.port}, starting fails instead of moving.`
              : t`Off: when ${port.port} is taken, a free port is picked.`}
          </p>
        </div>
      )}
      <details className="group rounded-md border border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium">
          <ChevronRight className="h-3.5 w-3.5 transition group-open:rotate-90" />
          <Trans>Install &amp; build</Trans>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {[serving.install_cmd, serving.build_cmd].filter(Boolean).join(' · ') || t`nothing declared`}
          </span>
        </summary>
        <div className="space-y-3 border-t border-border px-3 py-3">
          {(
            [
              ['install_cmd', t`Install command`, t`Empty: derived from its package manager`],
              ['install_check', t`Installed when this path exists`, 'node_modules'],
              ['build_cmd', t`Build command`, t`No build step`],
            ] as const
          ).map(([key, label, placeholder]) => (
            <Field key={key} label={label}>
              <CommitInput
                value={serving[key] ?? ''}
                onCommit={(v) => set({ [key]: v })}
                placeholder={placeholder}
                aria-label={label}
              />
            </Field>
          ))}
        </div>
      </details>
    </div>
  );
}
