import { Artifact, ArtifactType } from '@sdk';
import { notify } from '@src/notifications';
import { useArtifactActions } from '@src/hooks/flow-hooks';
import { useCurrentArtifacts } from '@src/hooks/flow-hooks';
import { FileText, Loader2 } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { ArtifactCard } from './artifact-card';
import { getArtifactTypeConfig } from './artifact-type-config';

interface ArtifactsListProps {
  /** Filter by artifact type */
  filterType?: ArtifactType;
  /** Group artifacts by type */
  groupByType?: boolean;
  /** Show add button */
  showAdd?: boolean;
  /** Callback when add button is clicked */
  onAddClick?: () => void;
  /** Custom class name */
  className?: string;
}

export const ArtifactsList: React.FC<ArtifactsListProps> = ({ filterType, groupByType = true, className = '' }) => {
  const { data: artifacts = [], isLoading } = useCurrentArtifacts();
  const { deleteArtifact, isDeleting } = useArtifactActions();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Filter artifacts
  const filteredArtifacts = useMemo(() => {
    if (!filterType) return artifacts;
    return artifacts.filter((a) => a.artifact_type === filterType);
  }, [artifacts, filterType]);

  // Group artifacts by type
  const groupedArtifacts = useMemo(() => {
    if (!groupByType) {
      return { all: filteredArtifacts };
    }

    const groups: Record<string, Artifact[]> = {};

    filteredArtifacts.forEach((artifact) => {
      const type = artifact.artifact_type || ArtifactType.FILE;
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(artifact);
    });

    return groups;
  }, [filteredArtifacts, groupByType]);

  const handleDelete = useCallback(
    async (artifactId: string) => {
      setDeletingId(artifactId);
      try {
        await deleteArtifact(artifactId);
        notify.success({
          title: 'Artifact deleted',
          message: 'The artifact has been removed successfully.',
        });
      } catch (error) {
        notify.error({
          title: 'Failed to delete',
          message: error instanceof Error ? error.message : 'An error occurred',
        });
      } finally {
        setDeletingId(null);
      }
    },
    [deleteArtifact],
  );

  if (isLoading) {
    return (
      <div className={`flex h-64 items-center justify-center ${className}`}>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (filteredArtifacts.length === 0) {
    return (
      <div className={`flex h-64 flex-col items-center justify-center text-center ${className}`}>
        <FileText className="mb-3 h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">No artifacts yet</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Artifacts created during flow execution will appear here
        </p>
      </div>
    );
  }

  // Render grouped or flat list
  if (groupByType && Object.keys(groupedArtifacts).length > 1) {
    return (
      <div className={`space-y-6 ${className}`}>
        {Object.entries(groupedArtifacts).map(([type, artifactsInGroup]) => {
          if (artifactsInGroup.length === 0) return null;

          const typeConfig = getArtifactTypeConfig(type as ArtifactType);
          const Icon = typeConfig.icon;

          return (
            <div key={type}>
              <div className="mb-3 flex items-center gap-2">
                <Icon className={`h-5 w-5 ${typeConfig.color}`} />
                <h3 className="text-sm font-semibold">{typeConfig.label}</h3>
                <span className="text-xs text-muted-foreground">({artifactsInGroup.length})</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {artifactsInGroup.map((artifact) => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    onDelete={(id) => void handleDelete(id)}
                    isDeleting={isDeleting && deletingId === artifact.id}
                    showDelete
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Flat list
  return (
    <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 ${className}`}>
      {filteredArtifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          onDelete={(id) => void handleDelete(id)}
          isDeleting={isDeleting && deletingId === artifact.id}
          showDelete
        />
      ))}
    </div>
  );
};
