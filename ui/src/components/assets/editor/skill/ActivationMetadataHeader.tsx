import { ActivationMetadata, ActivationParser } from '@sdk';
import { useMemo } from 'react';

interface ActivationMetadataHeaderProps {
  content: string;
}

export function ActivationMetadataHeader({ content }: ActivationMetadataHeaderProps) {
  const metadata = useMemo((): ActivationMetadata | null => {
    try {
      const { metadata: parsedMetadata } = ActivationParser.parse(content);
      return parsedMetadata;
    } catch {
      return null;
    }
  }, [content]);

  if (!metadata) {
    return null;
  }

  return (
    <div className="border-b bg-muted/30 px-4 py-3">
      <div className="flex items-start gap-6">
        {/* Name and Description */}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-foreground">{metadata.name || 'Untitled Rule'}</h2>
          {metadata.description && (
            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{metadata.description}</p>
          )}
        </div>

        {/* Extra fields */}
        <div className="flex flex-shrink-0 flex-col gap-2">
          {Object.keys(metadata.extra).length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {Object.entries(metadata.extra).map(([key, value]) => (
                <span
                  key={key}
                  className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs"
                  title={`${key}: ${String(value)}`}
                >
                  {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
