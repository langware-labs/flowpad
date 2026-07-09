import { Trans } from '@lingui/react/macro';
import { useProjects } from '@src/hooks/use-projects';
import { ContextEntitiesEnum, dataContext, fsManager, FSItem, PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { Button } from '@src/components/ui/button';
import { Card, CardContent } from '@src/components/ui/card';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FileText, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export interface OnboardingCardProps {
  /** Called when visibility changes (for layout adjustments) */
  onVisibilityChange?: (visible: boolean) => void;
}

/**
 * OnboardingCard - Card for new users to get started with FlowPad
 *
 * Features:
 * - Dynamically lists all .md files from my_first_project
 * - Each file button opens directly in execute-flow view
 * - Dismissible with X button (persisted to localStorage)
 */
export function OnboardingCard({ onVisibilityChange }: OnboardingCardProps) {
  const { navigation } = useDockNavigation();
  const { projects } = useProjects();

  const [dismissed, setDismissed] = usePreference<boolean>(PrefKey.ONBOARDING_DISMISSED);
  const isVisible = !dismissed;

  const [sampleFiles, setSampleFiles] = useState<FSItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load sample files from my_first_project on mount
  useEffect(() => {
    const loadSampleFiles = async () => {
      try {
        const desktopInfo = dataContext.bootstrapInfo?.desktop_info;
        const workspacePath = desktopInfo?.paths?.workspace;

        if (!workspacePath) {
          setIsLoading(false);
          return;
        }

        const computeNodeTypeId = dataContext.computeNode?.typeId;
        if (!computeNodeTypeId) {
          setIsLoading(false);
          return;
        }

        const projectPath = `${workspacePath}/my_first_project`;
        const result = await fsManager.listDirectory(computeNodeTypeId, projectPath);

        const mdFiles = result.items
          .filter((item) => !item.is_dir && item.name.endsWith('.md'))
          .sort((a, b) => a.name.localeCompare(b.name));

        setSampleFiles(mdFiles);
      } catch (error) {
        console.warn('[OnboardingCard] Failed to load sample files:', error);
      } finally {
        setIsLoading(false);
      }
    };

    if (isVisible) {
      void loadSampleFiles();
    }
  }, [isVisible]);

  // Handle file click - set local project as current, then open in execute-flow view
  const handleFileClick = useCallback(
    (file: FSItem) => {
      void (async () => {
        const localProject = projects?.find((p) => p.uname === 'local');
        if (localProject) {
          await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, localProject.typeId);
          await dataContext.refreshProject();
        }
        navigation.openDock(DockPointer.forExecuteFlow({ vfsAbsPath: file.vfs_abs_path }));
      })();
    },
    [navigation, projects],
  );

  // Dismiss onboarding permanently
  const handleDismiss = useCallback(() => {
    setDismissed(true);
    onVisibilityChange?.(false);
  }, [onVisibilityChange, setDismissed]);

  if (!isVisible) {
    return null;
  }

  return (
    <Card className="relative my-4 w-full max-w-lg border-border/50 bg-muted/30">
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-6 w-6 text-muted-foreground hover:text-foreground"
        onClick={handleDismiss}
      >
        <X className="h-3 w-3" />
      </Button>
      <CardContent className="p-5">
        <h3 className="mb-1 text-base font-medium"><Trans>Get Started</Trans></h3>
        <p className="mb-4 text-sm text-muted-foreground"><Trans>Try a sample flow to see FlowPad in action</Trans></p>

        {isLoading ? (
          <div className="flex gap-2">
            <div className="h-9 w-32 animate-pulse rounded bg-muted"></div>
            <div className="h-9 w-32 animate-pulse rounded bg-muted"></div>
          </div>
        ) : sampleFiles.length > 0 ? (
          <div className="flex flex-col gap-2">
            {sampleFiles.map((file) => (
              <Button
                key={file.vfs_abs_path}
                variant="outline"
                size="sm"
                onClick={() => handleFileClick(file)}
                className="justify-start"
              >
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                {file.name.replace('.md', '')}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground"><Trans>No sample flows found</Trans></p>
        )}
      </CardContent>
    </Card>
  );
}
