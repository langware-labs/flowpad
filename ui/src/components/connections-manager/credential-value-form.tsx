import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { isRequired, isSecret, type CredentialSpec, type CredentialVar } from '@sdk';
import { MAX_ENV_VAR_VALUE_LENGTH } from '@src/constants/validation';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

/**
 * The committable-`.env.local` refusal, in one place.
 *
 * `write_env_local` rejects a file git does not ignore, and that used to surface
 * only as an error toast after a secret had been pasted. It is shown twice — on
 * the table, and again inside the modal that covers it — so the string lives
 * here rather than being written out at both call sites.
 */
export function EnvLocalBlockedNotice({
  reason,
  className,
}: {
  reason?: string | null;
  className?: string;
}) {
  return (
    <div
      className={className ?? 'rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm'}
      data-testid="env-local-blocked-notice"
    >
      {reason || (
        <Trans>
          .env.local is not ignored by git in this project, so a value written there would be
          committable. Add it to .gitignore first.
        </Trans>
      )}
    </div>
  );
}

/** One variable, as the form sees it. */
type Field = {
  envVar: string;
  spec: CredentialVar;
  /** Already in `.env.local` — shown as found, never re-asked. */
  present: boolean;
};

/** Through `varNames`, like every other consumer of a spec's variables — so the
 *  set the form ASKS for cannot drift from the set `pointersFor` declares. */
export function fieldsFor(spec: CredentialSpec, presentKeys: ReadonlySet<string>): Field[] {
  return spec.varNames.map((envVar) => ({
    envVar,
    spec: spec.vars?.[envVar] ?? {},
    present: presentKeys.has(envVar),
  }));
}

/**
 * The values for a credential, asked for once, before it is declared.
 *
 * Adding a connection is supposed to write the key — declaring the env var and
 * leaving it empty produces a "connection" that connects nothing, and (by the
 * rule that a credential exists when its values do) does not even render as a
 * row afterwards. So the tile asks first and declares second.
 *
 * A variable already sitting in `.env.local` is shown as found and never
 * re-asked: adopting a key you can already see in your own file is bookkeeping,
 * not a chore, so that case stays a single click with nothing to type.
 */
export function CredentialValueForm({
  spec,
  presentKeys,
  blocked,
  blockReason,
  busy,
  onCancel,
  onSave,
}: {
  spec: CredentialSpec | null;
  presentKeys: ReadonlySet<string>;
  /** `.env.local` is committable — writing a secret there is refused. */
  blocked?: boolean;
  blockReason?: string | null;
  busy?: boolean;
  onCancel: () => void;
  onSave: (values: Record<string, string>) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const [values, setValues] = React.useState<Record<string, string>>({});

  // Partitioned once: `present` is shown as found, `toAsk` gets a field.
  const { present, toAsk } = React.useMemo(() => {
    const all = spec ? fieldsFor(spec, presentKeys) : [];
    return { present: all.filter((f) => f.present), toAsk: all.filter((f) => !f.present) };
  }, [spec, presentKeys]);

  React.useEffect(() => setValues({}), [spec?.name]);

  if (!spec) return null;

  const isValid = (f: Field): boolean => {
    const value = values[f.envVar] ?? '';
    if (!value) return !isRequired(f.spec);
    // Caught here rather than at the backend, which is where an oversized paste
    // used to fail — the guard the retired declare dialog carried.
    if (value.length > MAX_ENV_VAR_VALUE_LENGTH) return false;
    if (!f.spec.pattern) return true;
    try {
      return new RegExp(f.spec.pattern).test(value);
    } catch {
      // A bad pattern in a shipped asset must not make a key unenterable.
      return true;
    }
  };

  const canSave = !blocked && !busy && toAsk.every(isValid);

  return (
    <Dialog open={!!spec} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-lg" data-testid="credential-value-form">
        <DialogHeader>
          <DialogTitle>{spec.title || String(spec.name ?? '')}</DialogTitle>
          <DialogDescription>
            {spec.description || (
              <Trans>The value is written to this project's .env.local and stays on this machine.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Repeated inside the modal on purpose: it covers the table's copy. */}
        {blocked && <EnvLocalBlockedNotice reason={blockReason} />}

        <div className="space-y-3">
          {present.map((f) => (
              <div key={f.envVar} className="flex items-center gap-2 text-sm">
                <code className="text-xs">{f.envVar}</code>
                <span className="text-muted-foreground">
                  <Trans>already in .env.local</Trans>
                </span>
              </div>
          ))}

          {toAsk.map((f) => (
            <div key={f.envVar} className="space-y-1">
              <Label htmlFor={`cred-${f.envVar}`} className="text-xs">
                <code>{f.envVar}</code>
                {!isRequired(f.spec) && (
                  <span className="ms-2 text-muted-foreground">
                    <Trans>optional</Trans>
                  </span>
                )}
              </Label>
              <Input
                id={`cred-${f.envVar}`}
                type={isSecret(f.spec) ? 'password' : 'text'}
                autoComplete="off"
                disabled={blocked || busy}
                placeholder={f.spec.placeholder || f.spec.hint || f.spec.label || ''}
                value={values[f.envVar] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.envVar]: e.target.value }))}
                data-testid={`credential-value-${f.envVar}`}
              />
              {f.spec.help_url && (
                <a
                  href={f.spec.help_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-muted-foreground underline"
                >
                  <Trans>Where do I get this?</Trans>
                </a>
              )}
            </div>
          ))}

          {!toAsk.length && !blocked && (
            <p className="text-sm text-muted-foreground">
              <Trans>Every value is already on this machine — nothing to type.</Trans>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => void onSave(values)}
            data-testid="credential-value-save"
          >
            {busy ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
