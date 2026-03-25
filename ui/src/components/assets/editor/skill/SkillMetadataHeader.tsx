import { SkillMetadata } from '@sdk';
import { Input } from '@src/components/ui/input';

interface SkillMetadataHeaderProps {
  metadata: SkillMetadata | null;
  onMetadataChange?: (field: 'name' | 'description', value: string) => void;
}

export function SkillMetadataHeader({ metadata, onMetadataChange }: SkillMetadataHeaderProps) {
  if (!metadata) {
    return null;
  }

  return (
    <div className="border-b bg-muted/30 px-4 py-3">
      <div className="flex items-start gap-6">
        {/* Name and Description */}
        <div className="min-w-0 flex-1 space-y-1">
          {onMetadataChange ? (
            <Input
              value={metadata.name}
              onChange={(e) => onMetadataChange('name', e.target.value)}
              placeholder="skill-name"
              className="h-8 text-lg font-semibold"
            />
          ) : (
            <h2 className="truncate text-lg font-semibold text-foreground">{metadata.name || 'Untitled Skill'}</h2>
          )}
          {onMetadataChange ? (
            <Input
              value={metadata.description}
              onChange={(e) => onMetadataChange('description', e.target.value)}
              placeholder="Brief description of what this skill does"
              className="h-7 text-sm text-muted-foreground"
            />
          ) : (
            metadata.description && (
              <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{metadata.description}</p>
            )
          )}
        </div>

        {/* Tags and Tools */}
        <div className="flex flex-shrink-0 flex-col gap-2">
          {/* Tags */}
          {metadata.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Tags:</span>
              {metadata.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Allowed Tools */}
          {metadata.allowedTools.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Tools:</span>
              {metadata.allowedTools.map((tool) => (
                <span key={tool} className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs">
                  {tool}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
