import { ArtifactType, CodebaseReferenceType, IArtifact } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { notify } from '@src/notifications';
import { useArtifactActions } from '@src/hooks/flow-hooks';
import { Loader2 } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArtifactMetadataEditor } from './artifact-metadata-editor';
import { getArtifactTypeConfig, getArtifactTypeOptions } from './artifact-type-config';

interface ArtifactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface FormState {
  name: string;
  artifactType: ArtifactType | null;
  refType: CodebaseReferenceType;
  path: string;
  description: string;
  metadata: Record<string, unknown>;
}

const initialFormState: FormState = {
  name: '',
  artifactType: null,
  refType: CodebaseReferenceType.FILE,
  path: '',
  description: '',
  metadata: {},
};

export const ArtifactForm: React.FC<ArtifactFormProps> = ({ open, onOpenChange, onSuccess }) => {
  const { t } = useLingui();
  const { addArtifact, isAdding } = useArtifactActions();
  const [formState, setFormState] = useState<FormState>(initialFormState);

  const artifactTypeOptions = useMemo(() => getArtifactTypeOptions(), []);

  const handleTypeChange = useCallback((type: string) => {
    const artifactType = type as ArtifactType;
    const config = getArtifactTypeConfig(artifactType);

    setFormState((prev) => ({
      ...prev,
      artifactType,
      refType: config.defaultRefType,
      // Reset metadata when type changes
      metadata: {},
    }));
  }, []);

  const handleMetadataChange = useCallback((metadata: Record<string, unknown>) => {
    setFormState((prev) => ({
      ...prev,
      metadata,
    }));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!formState.name.trim()) {
        notify.error({
          title: t`Validation error`,
          message: t`Name is required`,
        });
        return;
      }

      // Build artifact data
      const artifactData: Partial<IArtifact> = {
        name: formState.name.trim(),
        artifact_type: formState.artifactType || ArtifactType.FILE,
        ref_type: formState.refType,
        path: formState.path.trim() || '.',
        description: formState.description.trim() || undefined,
        metadata: {
          ...formState.metadata,
        },
      };

      // Extract port to top level if present (for WEBAPP/APP_SERVICE)
      const metaPort = formState.metadata.port;
      if (metaPort !== undefined && metaPort !== null) {
        const portStr = typeof metaPort === 'string' ? metaPort : JSON.stringify(metaPort);
        artifactData.port = portStr;
        // Keep port in metadata too for frontend reading
        artifactData.metadata = {
          ...artifactData.metadata,
          port: portStr,
        };
      }

      // Extract start_cmd if present
      const metaStartCmd = formState.metadata.start_cmd;
      if (metaStartCmd !== undefined && metaStartCmd !== null) {
        artifactData.start_cmd = typeof metaStartCmd === 'string' ? metaStartCmd : JSON.stringify(metaStartCmd);
      }

      // Extract health if present
      const metaHealth = formState.metadata.health;
      if (metaHealth !== undefined && metaHealth !== null) {
        artifactData.health = typeof metaHealth === 'string' ? metaHealth : JSON.stringify(metaHealth);
      }

      try {
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
    [formState, addArtifact, onOpenChange, onSuccess],
  );

  const handleCancel = useCallback(() => {
    setFormState(initialFormState);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle><Trans>Add Artifact</Trans></DialogTitle>
          <DialogDescription><Trans>Create a new artifact in this project.</Trans></DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="name">
              <Trans>Name</Trans> <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              placeholder={t`My Artifact`}
              value={formState.name}
              onChange={(e) => setFormState((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>

          {/* Artifact Type */}
          <div className="space-y-2">
            <Label htmlFor="artifact-type"><Trans>Type</Trans></Label>
            <Select value={formState.artifactType || ''} onValueChange={handleTypeChange}>
              <SelectTrigger>
                <SelectValue placeholder={t`Select artifact type`} />
              </SelectTrigger>
              <SelectContent>
                {artifactTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Reference Type */}
          <div className="space-y-2">
            <Label htmlFor="ref-type"><Trans>Reference Type</Trans></Label>
            <Select
              value={formState.refType}
              onValueChange={(value) => setFormState((prev) => ({ ...prev, refType: value as CodebaseReferenceType }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CodebaseReferenceType.FILE}><Trans>File</Trans></SelectItem>
                <SelectItem value={CodebaseReferenceType.FOLDER}><Trans>Folder</Trans></SelectItem>
                <SelectItem value={CodebaseReferenceType.URL}><Trans>URL</Trans></SelectItem>
                <SelectItem value={CodebaseReferenceType.REFERENCE}><Trans>Reference</Trans></SelectItem>
                <SelectItem value={CodebaseReferenceType.GLOB}><Trans>Glob Pattern</Trans></SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Path */}
          <div className="space-y-2">
            <Label htmlFor="path"><Trans>Path</Trans></Label>
            <Input
              id="path"
              placeholder={t`./src/app or https://... (optional)`}
              value={formState.path}
              onChange={(e) => setFormState((prev) => ({ ...prev, path: e.target.value }))}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description"><Trans>Description</Trans></Label>
            <Input
              id="description"
              placeholder={t`Optional description`}
              value={formState.description}
              onChange={(e) => setFormState((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>

          {/* Type-specific metadata */}
          <div className="space-y-2">
            <Label><Trans>Metadata</Trans></Label>
            <div className="rounded-md border p-3">
              <ArtifactMetadataEditor
                artifactType={formState.artifactType}
                metadata={formState.metadata}
                onChange={handleMetadataChange}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancel} disabled={isAdding}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={isAdding}>
              {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Trans>Add Artifact</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
