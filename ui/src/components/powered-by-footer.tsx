import { BASE_PATH } from '@src/constants/basePath';
import { WarningsPopover } from '@src/components/warnings-popover';
import { Agent, ArtifactType, TypeId } from '@sdk';
import { useCurrentArtifacts } from '@src/hooks/flow-hooks';
import { useEntity } from '@src/hooks/entity-hooks';
import { useTheme } from 'next-themes';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useColorPalette } from '@src/hooks/useColorPalette';

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
  const { agentId } = useParams();
  const agentTypeId = useMemo(() => (agentId ? new TypeId(Agent.type, agentId) : null), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const { data: projectArtifacts } = useCurrentArtifacts();
  const { resolvedTheme } = useTheme();
  useColorPalette(agent?.site_config);

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
      className={`relative z-10 w-full border-t bg-background/95 px-6 py-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60 ${className}`}
    >
      <div className="flex items-center justify-between">
        {/* Warnings icon on the left */}
        <div className="relative">
          <WarningsPopover />
        </div>

        {/* Repo info aligned with content panel start (35% chat + handle + padding) */}
        <div className="absolute left-[40%]">
          {repoInfo && (
            <div className="font-mono text-[10px] text-muted-foreground">
              {repoInfo.isZip ? repoInfo.url : `${repoInfo.url}:${repoInfo.branch}`}
            </div>
          )}
        </div>

        {/* Powered by on the right */}
        <div className="ml-auto flex items-end">
          <span className="mr-2 text-[10px] text-muted-foreground">Powered by</span>
          <a
            href="https://flowpad.ai"
            onClick={(e) => {
              const electronAPI = (window as any).electronAPI;
              if (electronAPI?.openExternal) {
                e.preventDefault();
                electronAPI.openExternal('https://flowpad.ai');
              }
            }}
          >
            <img
              src={`${BASE_PATH}logo.png`}
              alt="Flowpad.ai Logo"
              className={`h-4 ${resolvedTheme === 'dark' ? 'brightness-0 invert' : ''}`}
            />
          </a>
        </div>
      </div>
    </footer>
  );
}
