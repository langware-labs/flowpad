import { Checkbox } from '@src/components/ui/checkbox';
import { Trans } from '@lingui/react/macro';

interface AutoLoginFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Test hook for the label. Each dialog names its own; the warning below
   *  keeps one stable id, since there is only ever one on screen. */
  testId: string;
  /** Spacing from whatever sits above it — the only thing that differs
   *  between the two dialogs that render this. */
  className?: string;
}

/**
 * The "sign me in automatically" tick, and the one consequence of clearing it.
 *
 * Auto-login is NOT just about Inbox and shared conversations. The box spends a
 * hub LLM budget with the login key it holds, and the hub's `setup_llm_endpoint`
 * only runs after a verified login — so a box launched with this off has no
 * funding at all, and its coding harnesses fall back to their own device logins.
 * Nothing in the tick's own wording hints at that, and someone clearing it for
 * privacy reasons would never guess it, so the warning says it outright.
 *
 * This is a shared component rather than markup in each dialog because the tick
 * has TWO entry points — creating a sandbox and launching an already-created one
 * — and a warning attached to only one of them is the same silent gap it exists
 * to close. Adding a third caller gets the warning for free.
 */
export function AutoLoginField({ checked, onChange, testId, className }: AutoLoginFieldProps) {
  return (
    <div className={className}>
      <label className="flex items-start gap-2 text-xs" data-testid={testId}>
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
        <span className="text-muted-foreground">
          <Trans>Sign me in automatically — this sandbox belongs to one person.</Trans>
        </span>
      </label>
      {!checked && (
        <p className="mt-1.5 ps-6 text-xs text-amber-600 dark:text-amber-500" data-testid="sandbox-no-funding">
          <Trans>
            Without signing in, this sandbox can't draw on your token plan — its coding assistants will each need their
            own login inside the box.
          </Trans>
        </p>
      )}
    </div>
  );
}
