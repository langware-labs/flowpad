import { Artifact, kindMatches } from '@sdk';
import { notify } from '@src/notifications';
import { useArtifactActions } from '@src/hooks/flow-hooks';
import { useCurrentArtifacts } from '@src/hooks/flow-hooks';
import { FileText, Loader2 } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArtifactCard } from './artifact-card';
import { EntityIcon } from '../graph-view/ui/EntityIcon';

interface ArtifactsListProps {
  /** Filter by the open dot-path kind. */
  filterKind?: string;
  /** @deprecated Use filterKind. */
  filterType?: string;
  /** Group artifacts by kind. */
  groupByType?: boolean;
  /** Show add button */
  showAdd?: boolean;
  /** Callback when add button is clicked */
  onAddClick?: () => void;
  /** Custom class name */
  className?: string;
}

export const ArtifactsList: React.FC<ArtifactsListProps> = ({
  filterKind,
  filterType,
  groupByType = true,
  className = '',
}) => {
  const { data: artifacts = [], isLoading } = useCurrentArtifacts();
  const { deleteArtifact, isDeleting } = useArtifactActions();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { t } = useLingui();

  // Filter artifacts
  const filteredArtifacts = useMemo(() => {
    const requestedKind = filterKind ?? filterType;
    if (!requestedKind) return artifacts;
    return artifacts.filter((artifact) => kindMatches(requestedKind, artifact.kind));
  }, [artifacts, filterKind, filterType]);

  // Group artifacts by type
  const groupedArtifacts = useMemo(() => {
    if (!groupByType) {
      return { all: filteredArtifacts };
    }

    const groups: Record<string, Artifact[]> = {};

    filteredArtifacts.forEach((artifact) => {
      const kind = artifact.kind;
      if (!groups[kind]) {
        groups[kind] = [];
      }
      groups[kind].push(artifact);
    });

    return groups;
  }, [filteredArtifacts, groupByType]);

  const handleDelete = useCallback(
    async (artifactId: string) => {
      setDeletingId(artifactId);
      try {
        await deleteArtifact(artifactId);
        notify.success({
          title: t`Artifact deleted`,
          message: t`The artifact has been removed successfully.`,
        });
      } catch (error) {
        notify.error({
          title: t`Failed to delete`,
          message: error instanceof Error ? error.message : t`An error occurred`,
        });
      } finally {
        setDeletingId(null);
      }
    },
    [deleteArtifact, t],
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
        <p className="text-sm font-medium text-muted-foreground"><Trans>No artifacts yet</Trans></p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          <Trans>Artifacts created during flow execution will appear here</Trans>
        </p>
      </div>
    );
  }

  // Render grouped or flat list
  if (groupByType && Object.keys(groupedArtifacts).length > 1) {
    return (
      <div className={`space-y-6 ${className}`}>
        {Object.entries(groupedArtifacts).map(([kind, artifactsInGroup]) => {
          if (artifactsInGroup.length === 0) return null;

          return (
            <div key={kind}>
              <div className="mb-3 flex items-center gap-2">
                <EntityIcon type={Artifact.type} size={18} />
                <h3 className="font-mono text-sm font-semibold">{kind}</h3>
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
