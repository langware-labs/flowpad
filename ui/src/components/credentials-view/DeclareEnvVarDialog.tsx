import { Trans, useLingui } from '@lingui/react/macro';
import type { SecretOriginLocator, SecretPointerScope } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { Textarea } from '@src/components/ui/textarea';
import { MAX_ENV_VAR_VALUE_LENGTH } from '@src/constants/validation';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { useSecretOriginLabel } from '@src/components/secrets/OriginChip';
import {
  DEFAULT_ORIGIN_KIND,
  OFFERED_ORIGIN_KINDS,
  originKindSpec,
} from '@src/components/secrets/secret-origin-kinds';

const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

export interface DeclareSubmit {
  envVar: string;
  description: string;
  locator: SecretOriginLocator;
  sodStore: string;
  scope: SecretPointerScope;
  /** Empty when none was given, or when the chosen kind cannot take one. */
  value: string;
}

interface DeclareEnvVarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills the name; when set the name is locked (declaring an existing row). */
  lockedEnvVar?: string;
  /** Names already on this screen — drives the "already exists" note. */
  existingEnvVars: string[];
  onSubmit: (submit: DeclareSubmit) => Promise<void>;
}

/**
 * Declare an environment variable this project needs.
 *
 * The shape follows what the model actually is: the NAME is the identity, the
 * VALUE is optional (a declaration may legitimately sit unmet), and WHERE the
 * value comes from is a detail that defaults to the local encrypted keychain and
 * lives behind a disclosure. Most declarations are name + value.
 */
export const DeclareEnvVarDialog: React.FC<DeclareEnvVarDialogProps> = ({
  open,
  onOpenChange,
  lockedEnvVar,
  existingEnvVars,
  onSubmit,
}) => {
  const { t } = useLingui();
  const originLabel = useSecretOriginLabel();

  const [envVar, setEnvVar] = useState('');
  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<SecretOriginLocator['kind']>(DEFAULT_ORIGIN_KIND);
  const [coord, setCoord] = useState('');
  const [scope, setScope] = useState<SecretPointerScope>('private');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEnvVar(lockedEnvVar ?? '');
    setDescription('');
    setValue('');
    setKind(DEFAULT_ORIGIN_KIND);
    setCoord('');
    setScope('private');
    setAdvanced(false);
  }, [open, lockedEnvVar]);

  const spec = originKindSpec(kind) ?? OFFERED_ORIGIN_KINDS[0];
  const collides = !lockedEnvVar && existingEnvVars.includes(envVar);
  // An existing row already holds a value; declaring only records where it comes
  // from. Offering a value box here would invite silently overwriting it.
  const canTakeValue = spec.provideable && !collides && !lockedEnvVar;
  const nameValid = ENV_VAR_RE.test(envVar);

  const submit = async () => {
    if (!nameValid || busy) return;
    if (value.length > MAX_ENV_VAR_VALUE_LENGTH) {
      notify.error({
        title: t`Value too long`,
        message: t`Values are limited to ${MAX_ENV_VAR_VALUE_LENGTH} characters.`,
      });
      return;
    }
    const coordVal = coord.trim() || envVar;
    setBusy(true);
    try {
      await onSubmit({
        envVar,
        description: description.trim(),
        locator: { kind, [spec.coordField]: coordVal } as unknown as SecretOriginLocator,
        sodStore: spec.defaultStore,
        // A local pointer names an entry in THIS machine's keychain, so it is
        // meaningless to a receiver — never offer to share it.
        scope: kind === 'local' ? 'private' : scope,
        value: canTakeValue ? value : '',
      });
      onOpenChange(false);
    } catch (e) {
      notify.error({
        title: t`Could not declare`,
        message: errorMessage(e, t`Failed to declare the environment variable`),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {lockedEnvVar ? <Trans>Record where {lockedEnvVar} comes from</Trans> : <Trans>Declare an environment variable</Trans>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">
              <Trans>Environment variable</Trans>
            </label>
            <Input
              value={envVar}
              onChange={(e) => setEnvVar(e.target.value.toUpperCase())}
              placeholder={t`OPENAI_API_KEY`}
              className="font-mono"
              disabled={!!lockedEnvVar}
              autoFocus={!lockedEnvVar}
              data-testid="declare-env-var"
            />
            {envVar && !nameValid && (
              <p className="mt-1 text-xs text-destructive">
                <Trans>Uppercase letters, numbers and underscores only.</Trans>
              </p>
            )}
            {collides && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="declare-collision-note">
                <Trans>
                  {envVar} already exists here. This records where it comes from; the current value is
                  kept.
                </Trans>
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium">
              <Trans>Description</Trans>
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t`What this secret is for`}
              rows={2}
              data-testid="declare-description"
            />
          </div>

          {canTakeValue && (
            <div>
              <label className="text-sm font-medium">
                <Trans>Value</Trans>{' '}
                <span className="font-normal text-muted-foreground">
                  <Trans>(optional — you can provide it later)</Trans>
                </span>
              </label>
              <Input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t`Leave empty to declare the need only`}
                data-testid="declare-value"
              />
            </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="declare-advanced-toggle"
            >
              {advanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <Trans>Where does it come from?</Trans>
              {!advanced && <span className="opacity-70">— {originLabel(kind)}</span>}
            </button>

            {advanced && (
              <div className="mt-2 space-y-3 rounded border border-border p-3">
                <div>
                  <label className="text-xs font-medium">
                    <Trans>Location</Trans>
                  </label>
                  <Select
                    value={kind}
                    onValueChange={(v) => setKind(v as SecretOriginLocator['kind'])}
                  >
                    <SelectTrigger data-testid="declare-origin-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OFFERED_ORIGIN_KINDS.map((k) => (
                        <SelectItem key={k.kind} value={k.kind}>
                          {originLabel(k.kind)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!spec.provideable && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <Trans>
                        Values for this location are held elsewhere — the declaration records the need
                        and reads as missing until that location has it.
                      </Trans>
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-xs font-medium">
                    <Trans>Coordinate</Trans>
                  </label>
                  <Input
                    value={coord}
                    onChange={(e) => setCoord(e.target.value)}
                    placeholder={envVar || spec.coordField}
                    className="font-mono"
                    data-testid="declare-coordinate"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>Empty uses the variable name.</Trans>
                  </p>
                </div>

                {kind !== 'local' && (
                  <div>
                    <label className="text-xs font-medium">
                      <Trans>Scope</Trans>
                    </label>
                    <Select value={scope} onValueChange={(v) => setScope(v as SecretPointerScope)}>
                      <SelectTrigger data-testid="declare-scope">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="private">{t`Private to me`}</SelectItem>
                        <SelectItem value="shared">{t`Shared with the project`}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!nameValid || busy} onClick={() => void submit()} data-testid="declare-submit">
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            <Trans>Declare</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
