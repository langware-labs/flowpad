import { ArtifactType } from '@sdk';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import React, { useCallback } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { getArtifactTypeConfig, MetadataFieldDef } from './artifact-type-config';

interface ArtifactMetadataEditorProps {
  artifactType: ArtifactType | null;
  metadata: Record<string, unknown>;
  onChange: (metadata: Record<string, unknown>) => void;
}

/**
 * Renders metadata fields based on artifact type configuration.
 * Falls back to JSON editor when no type is selected.
 */
export const ArtifactMetadataEditor: React.FC<ArtifactMetadataEditorProps> = ({ artifactType, metadata, onChange }) => {
  const handleFieldChange = useCallback(
    (key: string, value: string | number) => {
      onChange({
        ...metadata,
        [key]: value,
      });
    },
    [metadata, onChange],
  );

  // No type selected - show JSON editor
  if (!artifactType) {
    return <JsonMetadataEditor metadata={metadata} onChange={onChange} />;
  }

  const config = getArtifactTypeConfig(artifactType);
  const fields = config.metadataFields;

  // No metadata fields for this type
  if (fields.length === 0) {
    return (
      <div className="text-sm text-muted-foreground"><Trans>No additional metadata fields for {config.label} artifacts.</Trans></div>
    );
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <MetadataField
          key={field.key}
          field={field}
          value={metadata[field.key] as string | number | undefined}
          onChange={(value) => handleFieldChange(field.key, value)}
        />
      ))}
    </div>
  );
};

interface MetadataFieldProps {
  field: MetadataFieldDef;
  value: string | number | undefined;
  onChange: (value: string | number) => void;
}

const MetadataField: React.FC<MetadataFieldProps> = ({ field, value, onChange }) => {
  const { t } = useLingui();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const newValue = field.type === 'number' ? Number(e.target.value) : e.target.value;
      onChange(newValue);
    },
    [field.type, onChange],
  );

  const handleSelectChange = useCallback(
    (newValue: string) => {
      onChange(newValue);
    },
    [onChange],
  );

  return (
    <div className="space-y-2">
      <Label htmlFor={field.key} className="flex items-center gap-1">
        {field.label}
        {field.required && <span className="text-destructive">*</span>}
      </Label>

      {field.type === 'select' && field.options ? (
        <Select value={String(value || '')} onValueChange={handleSelectChange}>
          <SelectTrigger>
            <SelectValue placeholder={t`Select ${field.label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'textarea' ? (
        <textarea
          id={field.key}
          className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={field.placeholder}
          value={String(value || '')}
          onChange={handleChange}
        />
      ) : (
        <Input
          id={field.key}
          type={field.type === 'number' ? 'number' : 'text'}
          placeholder={field.placeholder}
          value={String(value || '')}
          onChange={handleChange}
        />
      )}

      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  );
};

interface JsonMetadataEditorProps {
  metadata: Record<string, unknown>;
  onChange: (metadata: Record<string, unknown>) => void;
}

/**
 * Simple JSON editor for metadata when no type is selected.
 */
const JsonMetadataEditor: React.FC<JsonMetadataEditorProps> = ({ metadata, onChange }) => {
  const { t } = useLingui();
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [jsonText, setJsonText] = React.useState(() => {
    return Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : '';
  });

  const handleJsonChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setJsonText(text);

      if (!text.trim()) {
        setJsonError(null);
        onChange({});
        return;
      }

      try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          setJsonError(t`Metadata must be a JSON object`);
          return;
        }
        setJsonError(null);
        onChange(parsed);
      } catch {
        setJsonError(t`Invalid JSON`);
      }
    },
    [onChange],
  );

  return (
    <div className="space-y-2">
      <Label htmlFor="metadata-json"><Trans>Metadata (JSON)</Trans></Label>
      <textarea
        id="metadata-json"
        className={`flex min-h-[120px] w-full rounded-md border bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
          jsonError ? 'border-destructive' : 'border-input'
        }`}
        placeholder='{"key": "value"}'
        value={jsonText}
        onChange={handleJsonChange}
      />
      {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
      <p className="text-xs text-muted-foreground">
        <Trans>Select an artifact type above to get type-specific metadata fields.</Trans>
      </p>
    </div>
  );
};
