import { ViewToggle } from '@src/components/view-toggle/view-toggle';
import { PendingActionsChip } from '@src/components/footer/PendingActionsChip';
import { usePendingCompletionSound } from '@src/components/footer/usePendingCompletionSound';
import { PoweredBy } from '@src/components/powered-by';
import { IndexerStatusPill } from '@src/components/search-index/IndexerStatusPill';
import { StatusBar } from '@src/components/status-bar';
import { VersionPopover } from '@src/components/version-popover';
import { WarningsPopover } from '@src/components/warnings-popover';
import { Agent, ArtifactType, FLOWPAD_ASSISTANT_PROJECT_UNAME, TypeId } from '@sdk';
import { useCurrentArtifacts, useEntity } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { BookOpen, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useContext } from '@sdk/react/hooks';
import { useColorPalette } from '../hooks/useColorPalette';

interface FooterProps {
  className?: string;
}

interface ArtifactWithMetadata {
  artifact_type?: string;
  metadata?: {
    url?: string;
    name?: string;
    branch?: string;
  };
}

export function Footer({ className = '' }: FooterProps) {
  const { version } = useContext();
  const { agentId } = useParams();
  const agentTypeId = useMemo(() => (agentId ? new TypeId(Agent.type, agentId) : null), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const { data: projectArtifacts } = useCurrentArtifacts();
  const { navigation } = useDockNavigation();
  useColorPalette(agent?.site_config);
  usePendingCompletionSound();

  // Extract repo and branch info from artifacts
  const repoInfo = useMemo(() => {
    if (!projectArtifacts) return null;

    const repoArtifacts = projectArtifacts.filter(
      (artifact) => (artifact as ArtifactWithMetadata).artifact_type === ArtifactType.GIT_REPO,
    );

    if (repoArtifacts.length === 0) return null;

    const repoArtifact = repoArtifacts[0] as ArtifactWithMetadata;
    const metadata = repoArtifact?.metadata;

    if (!metadata?.url) return null;

    const isZipFile = !metadata.url.startsWith('http') && !metadata.url.startsWith('git');

    if (isZipFile) {
      const zipName = metadata.name || metadata.url.replace(/\.zip$/i, '');
      return { url: zipName, branch: null, isZip: true };
    }

    const branch = metadata.branch || 'main';
    return { url: metadata.url, branch, isZip: false };
  }, [projectArtifacts]);

  return (
    <footer
      data-testid="footer"
      className={`relative z-10 w-full border-t bg-background/95 px-6 py-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60 ${className}`}
    >
      <div className="flex items-center justify-between">
        {/* View toggle + Settings + Warnings icons on the left */}
        <div className="flex items-center gap-1">
          <ViewToggle />
          <button
            onClick={() => navigation.openSettings()}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <WarningsPopover />
        </div>

        {/* Status bar with project name */}
        <StatusBar className="ml-4" />

        {/* Repo info centered in the available space */}
        <div className="flex-1 text-center">
          {repoInfo && (
            <div className="font-mono text-[10px] text-muted-foreground">
              {repoInfo.isZip ? repoInfo.url : `${repoInfo.url}:${repoInfo.branch}`}
            </div>
          )}
        </div>

        {/* Version + Powered by on the right */}
        <div className="ml-auto flex items-center gap-2">
          <PendingActionsChip />
          <IndexerStatusPill />
          <button
            type="button"
            onClick={() => navigation.openDock(DockPointer.forProject(`@${FLOWPAD_ASSISTANT_PROJECT_UNAME}`))}
            className="flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Open Flowpad docs"
            aria-label="Flowpad docs"
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span>Flowpad docs</span>
          </button>
          {version && <VersionPopover currentVersion={version} />}
          <PoweredBy />
        </div>
      </div>
    </footer>
  );
}
