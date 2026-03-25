import { ContentCard } from '@src/components/ui/content-card';
import { ContentCardAction } from '@src/components/ui/content-card';
import { ContentCardActionButton } from '@src/components/ui/content-card';
import { ContentCardBody } from '@src/components/ui/content-card';
import { ContentCardContainer } from '@src/components/ui/content-card';
import { ContentCardHeader } from '@src/components/ui/content-card';
import { ContentCardIcon } from '@src/components/ui/content-card';
import { ContentCardSubtext } from '@src/components/ui/content-card';
import { ContentCardTitle } from '@src/components/ui/content-card';
import { GitCommit, GitCompare, Loader2, Undo2 } from 'lucide-react';
import React, { useCallback, useState } from 'react';

interface CheckpointSectionProps {
  checkpoint_hash: string;
  onCheckpointClick?: () => void;
  onRestore?: () => Promise<void>;
  collapsible?: boolean;
  className?: string;
}

const CheckpointSection: React.FC<CheckpointSectionProps> = ({
  checkpoint_hash,
  onCheckpointClick,
  onRestore,
  collapsible,
  className,
}) => {
  const [isRestoring, setIsRestoring] = useState(false);

  const handleCheckpointClick = useCallback(() => onCheckpointClick?.(), [onCheckpointClick]);

  const handleRestore = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();

      if (!onRestore || isRestoring) return;

      setIsRestoring(true);
      try {
        await onRestore();
      } finally {
        setIsRestoring(false);
      }
    },
    [onRestore, isRestoring],
  );

  return (
    <ContentCard
      className={className}
      onClick={handleCheckpointClick}
      clickable={!collapsible}
      collapsible={collapsible}
    >
      <ContentCardContainer>
        <ContentCardIcon>
          <GitCommit className="h-4 w-4" />
        </ContentCardIcon>
        <ContentCardBody>
          <ContentCardHeader>
            <ContentCardTitle>Checkpoint</ContentCardTitle>
          </ContentCardHeader>
          <ContentCardSubtext>{checkpoint_hash}</ContentCardSubtext>
        </ContentCardBody>
        <ContentCardAction>
          {onRestore && (
            <ContentCardActionButton
              size="icon"
              onClick={(e) => {
                void handleRestore(e);
              }}
              title={isRestoring ? 'Restoring checkpoint...' : 'Restore this checkpoint'}
              disabled={isRestoring}
            >
              {isRestoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            </ContentCardActionButton>
          )}
          <ContentCardActionButton size="icon">
            <GitCompare className="h-4 w-4" />
          </ContentCardActionButton>
        </ContentCardAction>
      </ContentCardContainer>
    </ContentCard>
  );
};

export default CheckpointSection;
