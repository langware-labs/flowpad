import { Artifact, formatGitOrigin, isGitOrigin, type FSOriginField } from '@sdk';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { artifactShareSource } from '@src/hooks/share-sources';
import { useDockNavigation } from '@src/navigation';
import { Share2, Trash2 } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { EntityIcon } from '../graph-view/ui/EntityIcon';
import { openArtifact } from './open-artifact';

interface ArtifactCardProps {
  artifact: Artifact;
  onDelete?: (artifactId: string) => void;
  isDeleting?: boolean;
  showDelete?: boolean;
  className?: string;
}

function originLabel(origin: FSOriginField | null | undefined): string | null {
  if (!origin) return null;
  if (isGitOrigin(origin)) return formatGitOrigin(origin);
  const base = origin.base.replace(/\/$/, '');
  return !origin.rel_path || origin.rel_path === '.' ? base : `${base}/${origin.rel_path}`;
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({
  artifact,
  onDelete,
  isDeleting = false,
  showDelete = true,
  className = '',
}) => {
  const { navigation } = useDockNavigation();
  const [shareOpen, setShareOpen] = useState(false);
  const shareSource = useMemo(() => artifactShareSource(artifact), [artifact]);
  const source = useMemo(() => originLabel(artifact.origin), [artifact.origin]);

  const handleClick = useCallback(() => {
    void openArtifact(artifact, { navigation });
  }, [artifact, navigation]);

  const handleDelete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (artifact.id && onDelete) onDelete(artifact.id);
    },
    [artifact.id, onDelete],
  );

  const handleShare = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setShareOpen(true);
  }, []);

  return (
    <div
      className={`group relative flex cursor-pointer flex-col rounded-lg border bg-card p-3 transition-colors hover:bg-accent ${className}`}
      onClick={handleClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <EntityIcon type={Artifact.type} remote={artifact.remote} size={16} />
          <span className="truncate text-sm font-medium">{artifact.displayName}</span>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {artifact.id && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={handleShare}
                  data-testid={`artifact-share-${artifact.id}`}
                >
                  <Share2 className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Share</TooltipContent>
            </Tooltip>
          )}

          {showDelete && onDelete && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={handleDelete}
                  disabled={isDeleting}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
          {artifact.kind}
        </span>
      </div>

      {source && (
        <p className="mt-2 truncate text-xs text-muted-foreground" title={source}>
          {source}
        </p>
      )}

      {artifact.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{artifact.description}</p>
      )}

      {shareOpen && (
        <ShareToConversationDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          source={shareSource}
        />
      )}
    </div>
  );
};
