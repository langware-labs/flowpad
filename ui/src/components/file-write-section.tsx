import { detectLanguage } from '@sdk';
import { ContentCard } from '@src/components/ui/content-card';
import { ContentCardAction } from '@src/components/ui/content-card';
import { ContentCardActionButton } from '@src/components/ui/content-card';
import { ContentCardBody } from '@src/components/ui/content-card';
import { ContentCardCollapsibleContent } from '@src/components/ui/content-card';
import { ContentCardContainer } from '@src/components/ui/content-card';
import { ContentCardHeader } from '@src/components/ui/content-card';
import { ContentCardIcon } from '@src/components/ui/content-card';
import { ContentCardTitle } from '@src/components/ui/content-card';
import { Download, FileText } from 'lucide-react';
import React from 'react';
import { EditorPane } from './code-editor/EditorPane';

interface FileWriteSectionProps {
  fileWrite: { path: string; content?: string };
  onFileWriteDownload?: () => void;
  collapsible?: boolean;
  className?: string;
}

const FileWriteSection: React.FC<FileWriteSectionProps> = ({
  fileWrite,
  onFileWriteDownload,
  collapsible,
  className,
}) => {
  return (
    <ContentCard className={className} collapsible={collapsible && !!fileWrite.content}>
      <ContentCardContainer className="px-3 py-1">
        <ContentCardIcon className="m-0 flex-shrink-0 p-0">
          <FileText className="h-3.5 w-3.5" />
        </ContentCardIcon>
        <ContentCardBody className="my-0 py-0">
          <ContentCardHeader className="my-0 py-0">
            <ContentCardTitle className="m-0 truncate p-0 text-sm leading-none">
              File Written: {fileWrite.path}
            </ContentCardTitle>
          </ContentCardHeader>
        </ContentCardBody>
        {onFileWriteDownload && (
          <ContentCardAction>
            <ContentCardActionButton size="icon" onClick={onFileWriteDownload}>
              <Download className="h-4 w-4" />
            </ContentCardActionButton>
          </ContentCardAction>
        )}
      </ContentCardContainer>
      {collapsible && fileWrite.content && (
        <ContentCardCollapsibleContent className="h-[32rem]">
          <EditorPane
            file={{ path: fileWrite.path, content: fileWrite.content, language: detectLanguage(fileWrite.path) }}
            readOnly
          />
        </ContentCardCollapsibleContent>
      )}
    </ContentCard>
  );
};

export default FileWriteSection;
