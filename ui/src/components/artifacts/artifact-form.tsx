import { ARTIFACT_KINDS, gitOriginFromUrl, normalizeKind, type FSOriginField, type IArtifact } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useArtifactActions } from '@src/hooks/flow-hooks';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Loader2 } from 'lucide-react';
import React, { useCallback, useState } from 'react';

interface ArtifactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type OriginKind = 'none' | 'local' | 'git';

interface FormState {
  name: string;
  kind: string;
  description: string;
  originKind: OriginKind;
  originLocator: string;
  originBranch: string;
  originRelPath: string;
}

const initialFormState: FormState = {
  name: '',
  kind: '',
  description: '',
  originKind: 'none',
  originLocator: '',
  originBranch: '',
  originRelPath: '.',
};

const KIND_SUGGESTIONS = Object.values(ARTIFACT_KINDS);

function originFromForm(state: FormState): FSOriginField | null {
  if (state.originKind === 'none') return null;
  const relPath = state.originRelPath.trim() || '.';
  if (state.originKind === 'local') {
    const base = state.originLocator.trim();
    if (!base) throw new Error('Local source base is required');
    return { kind: 'local', base, rel_path: relPath };
  }
  const origin = gitOriginFromUrl(state.originLocator, state.originBranch.trim(), relPath);
  if (!origin) throw new Error('Enter a valid Git repository URL and relative path');
  return { ...origin, kind: 'git' };
}

export const ArtifactForm: React.FC<ArtifactFormProps> = ({ open, onOpenChange, onSuccess }) => {
  const { t } = useLingui();
  const { addArtifact, isAdding } = useArtifactActions();
  const [formState, setFormState] = useState<FormState>(initialFormState);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      try {
        const name = formState.name.trim();
        if (!name) throw new Error(t`Name is required`);
        const artifactData: Partial<IArtifact> = {
          name,
          kind: normalizeKind(formState.kind),
          description: formState.description.trim() || undefined,
          origin: originFromForm(formState),
        };
        await addArtifact(artifactData);
        notify.success({
          title: t`Artifact created`,
          message: t`${formState.name} has been added successfully.`,
        });
        setFormState(initialFormState);
        onOpenChange(false);
        onSuccess?.();
      } catch (error) {
        notify.error({
          title: t`Failed to create artifact`,
          message: error instanceof Error ? error.message : t`An error occurred`,
        });
      }
    },
    [addArtifact, formState, onOpenChange, onSuccess, t],
  );

  const handleCancel = useCallback(() => {
    setFormState(initialFormState);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add Artifact</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Describe the logical application, service, resource, or content and its optional source.</Trans>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="artifact-name">
              <Trans>Name</Trans> <span className="text-destructive">*</span>
            </Label>
            <Input
              id="artifact-name"
              placeholder={t`My web application`}
              value={formState.name}
              onChange={(event) => setFormState((previous) => ({ ...previous, name: event.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="artifact-kind">
              <Trans>Kind</Trans> <span className="text-destructive">*</span>
            </Label>
            <Input
              id="artifact-kind"
              list="artifact-kind-suggestions"
              placeholder="application.web"
              value={formState.kind}
              onChange={(event) => setFormState((previous) => ({ ...previous, kind: event.target.value }))}
            />
            <datalist id="artifact-kind-suggestions">
              {KIND_SUGGESTIONS.map((kind) => (
                <option value={kind} key={kind} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              <Trans>Open dot-path ontology; custom descendants are welcome.</Trans>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="artifact-description">
              <Trans>Description</Trans>
            </Label>
            <Input
              id="artifact-description"
              placeholder={t`Optional description`}
              value={formState.description}
              onChange={(event) => setFormState((previous) => ({ ...previous, description: event.target.value }))}
            />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label>
              <Trans>Source</Trans>
            </Label>
            <Select
              value={formState.originKind}
              onValueChange={(value) => setFormState((previous) => ({ ...previous, originKind: value as OriginKind }))}
            >
              <SelectTrigger aria-label={t`Source kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <Trans>No source</Trans>
                </SelectItem>
                <SelectItem value="local">
                  <Trans>Local path</Trans>
                </SelectItem>
                <SelectItem value="git">
                  <Trans>Git repository</Trans>
                </SelectItem>
              </SelectContent>
            </Select>

            {formState.originKind !== 'none' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="artifact-origin-locator">
                    {formState.originKind === 'git' ? <Trans>Repository URL</Trans> : <Trans>Base path</Trans>}
                  </Label>
                  <Input
                    id="artifact-origin-locator"
                    placeholder={formState.originKind === 'git' ? 'https://github.com/acme/app.git' : '/workspace/apps'}
                    value={formState.originLocator}
                    onChange={(event) =>
                      setFormState((previous) => ({ ...previous, originLocator: event.target.value }))
                    }
                  />
                </div>
                {formState.originKind === 'git' && (
                  <div className="space-y-2">
                    <Label htmlFor="artifact-origin-branch">
                      <Trans>Branch</Trans>
                    </Label>
                    <Input
                      id="artifact-origin-branch"
                      placeholder="main"
                      value={formState.originBranch}
                      onChange={(event) =>
                        setFormState((previous) => ({ ...previous, originBranch: event.target.value }))
                      }
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="artifact-origin-rel">
                    <Trans>Relative path</Trans>
                  </Label>
                  <Input
                    id="artifact-origin-rel"
                    placeholder="."
                    value={formState.originRelPath}
                    onChange={(event) =>
                      setFormState((previous) => ({ ...previous, originRelPath: event.target.value }))
                    }
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancel} disabled={isAdding}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={isAdding}>
              {isAdding && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              <Trans>Add Artifact</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
