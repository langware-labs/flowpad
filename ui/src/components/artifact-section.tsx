import { Artifact, ArtifactType, detectLanguage, downloadFileFromUrl, FlowData } from '@sdk';
import { ContentCard } from '@src/components/ui/content-card';
import { useDockNavigation } from '@src/navigation';
import { ContentCardAction } from '@src/components/ui/content-card';
import { ContentCardActionButton } from '@src/components/ui/content-card';
import { ContentCardBody } from '@src/components/ui/content-card';
import { ContentCardCollapsibleContent } from '@src/components/ui/content-card';
import { ContentCardContainer } from '@src/components/ui/content-card';
import { ContentCardHeader } from '@src/components/ui/content-card';
import { ContentCardIcon } from '@src/components/ui/content-card';
import { ContentCardTitle } from '@src/components/ui/content-card';
import { useFS, useProject } from '@sdk/react/hooks';
import { Download, FileBadge, Globe } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';
import { EditorPane } from './code-editor/EditorPane';

interface ArtifactSectionProps {
  flowData: FlowData<Artifact>;
  collapsible?: boolean;
  className?: string;
}

const ArtifactSection: React.FC<ArtifactSectionProps> = ({ flowData, collapsible, className }) => {
  const { navigation } = useDockNavigation();
  const { project } = useProject();
  const fs = useFS(project?.typeId);

  const {
    title,
    icon: Icon,
    resultPath,
    webAppPort,
  } = useMemo(() => {
    // Extract data from flowData
    const data: Artifact = flowData.data;
    if (!data) {
      console.warn('Missing data in flowData.', flowData);
      return {};
    }
    const artifactType = data.artifact_type;
    const resultPath = data.path;

    if (artifactType?.toLowerCase() === ArtifactType.WEBAPP.toLowerCase()) {
      return {
        title: `Web App : ${resultPath}`,
        icon: Globe,
        resultPath,
        webAppPort: data.metadata?.port as string,
      };
    }

    return {
      title: `Artifact : ${resultPath}`,
      icon: FileBadge,
      resultPath,
      webAppPort: undefined,
    };
  }, [flowData]);

  const handleResultClick = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation();
      if (webAppPort) {
        navigation.openWebApp(webAppPort);
      } else if (resultPath) {
        navigation.openFile(resultPath);
      }
    },
    [webAppPort, resultPath, navigation],
  );

  const handleResultDownloadClick = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation();
      if (!fs || !resultPath) return;
      const url = fs.getDownloadUrl(resultPath);
      downloadFileFromUrl(url);
    },
    [resultPath, fs],
  );

  // Show result if we have a path OR if it's a webapp (webapp might not have a path)
  const shouldShow = resultPath;

  return (
    shouldShow && (
      <ContentCard className={className} onClick={handleResultClick} clickable={!collapsible} collapsible={collapsible}>
        <ContentCardContainer className="px-3 py-1">
          <ContentCardIcon className="m-0 flex-shrink-0 p-0">
            <Icon className="h-3.5 w-3.5" />
          </ContentCardIcon>
          <ContentCardBody className="my-0 py-0">
            <ContentCardHeader className="my-0 py-0">
              <ContentCardTitle className="m-0 truncate p-0 text-sm leading-none">{title}</ContentCardTitle>
            </ContentCardHeader>
          </ContentCardBody>
          {!webAppPort && (
            <ContentCardAction>
              <ContentCardActionButton size="icon" onClick={handleResultDownloadClick}>
                <Download className="h-4 w-4" />
              </ContentCardActionButton>
            </ContentCardAction>
          )}
        </ContentCardContainer>
        {collapsible && flowData?.content && (
          <ContentCardCollapsibleContent className="h-[32rem]">
            <EditorPane
              file={{ path: resultPath, content: flowData?.content, language: detectLanguage(resultPath) }}
              readOnly
            />
          </ContentCardCollapsibleContent>
        )}
      </ContentCard>
    )
  );
};

export default ArtifactSection;
