import { Artifact, ArtifactType, downloadFileFromUrl } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation';
import { useFS, useProject } from '@sdk/react/hooks';
import { Download, ExternalLink, Share2, Trash2 } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { getArtifactTypeConfig } from './artifact-type-config';
import { openArtifact } from './open-artifact';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { artifactShareSource } from '@src/hooks/share-sources';

interface ArtifactCardProps {
  artifact: Artifact;
  onDelete?: (artifactId: string) => void;
  isDeleting?: boolean;
  showDelete?: boolean;
  className?: string;
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({
  artifact,
  onDelete,
  isDeleting = false,
  showDelete = true,
  className = '',
}) => {
  const { navigation } = useDockNavigation();
  const { project } = useProject();
  const fs = useFS(project?.typeId);
  const [shareOpen, setShareOpen] = useState(false);

  const typeConfig = useMemo(() => {
    return getArtifactTypeConfig(artifact.artifact_type || ArtifactType.FILE);
  }, [artifact.artifact_type]);

  const Icon = typeConfig.icon;

  const isWebApp = artifact.artifact_type === ArtifactType.WEBAPP;
  const isAppService = artifact.artifact_type === ArtifactType.APP_SERVICE;
  const hasPort = !!(artifact.port || artifact.metadata?.port);
  const shareSource = useMemo(() => artifactShareSource(artifact), [artifact]);

  const handleClick = useCallback(async () => {
    await openArtifact(artifact, { navigation, currentProjectId: project?.id ?? null });
  }, [artifact, navigation, project?.id]);

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!fs || !artifact.path) return;
      const url = fs.getDownloadUrl(artifact.path);
      downloadFileFromUrl(url);
    },
    [fs, artifact.path],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (artifact.id && onDelete) {
        onDelete(artifact.id);
      }
    },
    [artifact.id, onDelete],
  );

  const handleShare = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShareOpen(true);
  }, []);

  // Filter out internal metadata keys for display
  const displayMetadata = useMemo(() => {
    const meta = artifact.metadata || {};
    const internalKeys = ['port', 'start_cmd', 'start-cmd', 'health'];
    return Object.entries(meta).filter(([key]) => !internalKeys.includes(key));
  }, [artifact.metadata]);

  return (
    <div
      className={`group relative flex cursor-pointer flex-col rounded-lg border bg-card p-3 transition-colors hover:bg-accent ${className}`}
      onClick={handleClick}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <Icon className={`h-4 w-4 flex-shrink-0 ${typeConfig.color}`} />
          <span className="truncate text-sm font-medium">{artifact.displayName}</span>
        </div>

        {/* Actions */}
        <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {!isWebApp && !isAppService && artifact.path && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={handleDownload}>
                  <Download className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
          )}

          {(isWebApp || isAppService) && hasPort && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={handleClick}>
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open</TooltipContent>
            </Tooltip>
          )}

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

      {/* Type badge */}
      <div className="mt-1 flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{typeConfig.label}</span>
        {hasPort && (
          <span className="text-xs text-muted-foreground">
            Port:{' '}
            {artifact.port ||
              (typeof artifact.metadata?.port === 'string' || typeof artifact.metadata?.port === 'number'
                ? artifact.metadata.port
                : '')}
          </span>
        )}
      </div>

      {/* Path */}
      {artifact.path && (
        <p className="mt-1 truncate text-xs text-muted-foreground" title={artifact.path}>
          {artifact.path}
        </p>
      )}

      {/* Description */}
      {artifact.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{artifact.description}</p>
      )}

      {/* Display metadata */}
      {displayMetadata.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {displayMetadata.slice(0, 3).map(([key, value]) => (
            <span key={key} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {key}: {String(value)}
            </span>
          ))}
          {displayMetadata.length > 3 && (
            <span className="text-xs text-muted-foreground">+{displayMetadata.length - 3} more</span>
          )}
        </div>
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
