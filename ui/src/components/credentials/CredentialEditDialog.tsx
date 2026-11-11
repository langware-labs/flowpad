import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckCircle2, FlaskConical, Loader2, Pencil, XCircle } from 'lucide-react';
import { credentialsService, type CredentialStatusRow, type CredentialsStatus } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { currentDeployment } from '@src/components/credentials-view/credential-rows';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { describeApiError } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { isCli, loginCommands, valuesDraft, type DraftVar } from './credential-draft';
import { CredentialTestButton } from './CredentialTestButton';
import { FileValueInput } from './FileValueInput';
import { SecretValueInput } from './SecretValueInput';
import { SignInCommand } from './SignInCommand';

/**
 * A credential's keys on this computer, as a plain list: each variable, whether it is set here, Update to give
 * it a value, and Test where one applies. A second tab reads the setup instructions. The definition (names,
 * kinds, required) is not edited here — `onEditDefinition` opens the full form for that.
 */
export function CredentialEditDialog({
  row,
  status,
  projectId,
  onClose,
  onChanged,
  onEditDefinition,
}: {
  row: CredentialStatusRow;
  status: CredentialsStatus;
  projectId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onEditDefinition?: () => void;
}) {
  const { t } = useLingui();
  const vars = React.useMemo(() => valuesDraft(row).vars, [row]);
  const [open, setOpen] = React.useState<string | null>(null);
  const { isThisComputer } = currentDeployment(status);
  const result = row.test_result;
  // The credential's own test sits on the row of its first required key (else the first key).
  const testOn = row.has_test ? (vars.find((v) => v.required) ?? vars[0])?.envVar : undefined;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-testid="credential-edit-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Edit {row.title}</Trans>
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="keys">
          <TabsList>
            <TabsTrigger value="keys" data-testid="credential-edit-tab-keys">
              <Trans>Keys</Trans>
            </TabsTrigger>
            <TabsTrigger value="instructions" data-testid="credential-edit-tab-instructions">
              <Trans>Instructions</Trans>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="keys">
            <ul className="rounded-md border px-3" data-testid="credential-edit-keys">
              {vars.map((v) => (
                <KeyRow
                  key={v.id}
                  v={v}
                  row={row}
                  status={status}
                  isThisComputer={isThisComputer}
                  open={open === v.envVar}
                  onToggle={() => setOpen((o) => (o === v.envVar ? null : v.envVar))}
                  onChanged={onChanged}
                  test={
                    v.envVar === testOn ? (
                      <CredentialTestButton
                        typeid={row.typeid}
                        name={row.name}
                        title={row.title}
                        projectId={projectId}
                        hasTest
                        result={result}
                        onChanged={onChanged}
                        size="xs"
                        testId={`credential-edit-test-${v.envVar}`}
                      />
                    ) : null
                  }
                  testState={v.envVar === testOn ? result?.state : undefined}
                  testDetail={result?.detail}
                />
              ))}
            </ul>
          </TabsContent>
          <TabsContent value="instructions" data-testid="credential-edit-instructions">
            <div className="max-h-[65vh] space-y-2 overflow-y-auto">
              {onEditDefinition && (
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onEditDefinition}>
                    <Pencil className="h-3.5 w-3.5" />
                    <Trans>Edit</Trans>
                  </Button>
                </div>
              )}
              {row.setup?.trim() ? (
                <MarkdownView value={row.setup} compact />
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>No setup instructions yet.</Trans>
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="credential-edit-close">
            {t`Close`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyRow({
  v,
  row,
  status,
  isThisComputer,
  open,
  onToggle,
  onChanged,
  test,
  testState,
  testDetail,
}: {
  v: DraftVar;
  row: CredentialStatusRow;
  status: CredentialsStatus;
  isThisComputer: boolean;
  open: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void> | void;
  test: React.ReactNode;
  testState?: string;
  testDetail?: string;
}) {
  const { t } = useLingui();
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const present = !!row.vars.find((s) => s.env_var === v.envVar)?.present;
  const cli = isCli(v);

  const save = async () => {
    if (!value) return;
    setBusy(true);
    try {
      await credentialsService.setValues(row.typeid, { [v.envVar]: value }, status.deployment_id);
      setValue('');
      onToggle();
      await onChanged();
    } catch (error) {
      notify.error({ title: t`Could not set ${v.envVar}`, message: describeApiError(error, t`Not saved.`).message });
    } finally {
      setBusy(false);
    }
  };

  // A cli key has no stored value: its check passing is what "set" means, so Test re-reads that check.
  const recheck = async () => {
    setBusy(true);
    try {
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const badge =
    testState === 'ok' ? (
      <Badge variant="success" className="gap-1" title={t`Tested`} data-testid={`credential-key-state-${v.envVar}`}>
        <CheckCircle2 className="h-3 w-3" />
        <Trans>Works</Trans>
      </Badge>
    ) : testState === 'invalid' || testState === 'error' ? (
      <Badge variant="danger" className="gap-1" title={testDetail} data-testid={`credential-key-state-${v.envVar}`}>
        <XCircle className="h-3 w-3" />
        <Trans>Rejected</Trans>
      </Badge>
    ) : present ? (
      <Badge variant="success" data-testid={`credential-key-state-${v.envVar}`}>
        <Trans>Set</Trans>
      </Badge>
    ) : (
      <Badge variant="muted" data-testid={`credential-key-state-${v.envVar}`}>
        <Trans>Not set</Trans>
      </Badge>
    );

  return (
    <li className="border-b last:border-b-0" data-testid={`credential-key-${v.envVar}`}>
      <div className="flex items-center gap-2 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={v.label || v.envVar}>
          {v.envVar}
        </span>
        {badge}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={onToggle}
          data-testid={`credential-key-update-${v.envVar}`}
        >
          <Pencil className="h-3.5 w-3.5" />
          <Trans>Update</Trans>
        </Button>
        {test ??
          (cli && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={busy}
              onClick={() => void recheck()}
              data-testid={`credential-key-test-${v.envVar}`}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
              <Trans>Test</Trans>
            </Button>
          ))}
      </div>
      {open && (
        <div className="flex items-center gap-2 pb-3" data-testid={`credential-key-field-${v.envVar}`}>
          {cli ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {loginCommands(v, row).map((command) => (
                <SignInCommand key={command} command={command} thisComputer={isThisComputer} />
              ))}
            </div>
          ) : (
            <>
              {v.base.kind === 'file' ? (
                <div className="min-w-0 flex-1">
                  <FileValueInput
                    id={`credential-key-value-${v.envVar}`}
                    testId={`credential-key-value-${v.envVar}`}
                    secret={v.secret}
                    value={value}
                    onChange={setValue}
                  />
                </div>
              ) : (
                <SecretValueInput
                  className="min-w-0 flex-1"
                  secret={v.secret}
                  value={value}
                  placeholder={v.placeholder || t`Value`}
                  disabled={busy}
                  onValueChange={setValue}
                  aria-label={t`Value for ${v.envVar}`}
                  data-testid={`credential-key-value-${v.envVar}`}
                />
              )}
              <Button
                size="sm"
                disabled={busy || !value}
                onClick={() => void save()}
                data-testid={`credential-key-set-${v.envVar}`}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <Trans>Set</Trans>
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
