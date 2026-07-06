import { ArtifactType } from './artifact-types';

export interface ArtifactTypeInfo {
  type: ArtifactType;
  name: string;
  description: string;
  icon?: string;
}

export class ArtifactTypeMetadata {
  static fromArtifactType(type: ArtifactType): ArtifactTypeInfo {
    switch (type) {
      case ArtifactType.WEBPAGE:
        return {
          type: ArtifactType.WEBPAGE,
          name: 'Webpage',
          description: 'A webpage artifact',
          icon: 'globe',
        };
      case ArtifactType.FUNCTION:
        return {
          type: ArtifactType.FUNCTION,
          name: 'Function',
          description: 'A function artifact',
          icon: 'zap',
        };
      case ArtifactType.APP_SERVICE:
        return {
          type: ArtifactType.APP_SERVICE,
          name: 'App Service',
          description: 'An application service artifact',
          icon: 'rocket',
        };
      case ArtifactType.CLOUD_SERVICE:
        return {
          type: ArtifactType.CLOUD_SERVICE,
          name: 'Cloud Service',
          description: 'A cloud service artifact',
          icon: 'cloud',
        };
      case ArtifactType.FILE:
        return {
          type: ArtifactType.FILE,
          name: 'File',
          description: 'A file artifact',
          icon: 'file',
        };
      case ArtifactType.DATA:
        return {
          type: ArtifactType.DATA,
          name: 'Data',
          description: 'A data artifact',
          icon: 'database',
        };
      case ArtifactType.WEBAPP:
        return {
          type: ArtifactType.WEBAPP,
          name: 'Web App',
          description: 'A running web application accessible via browser',
          icon: 'layout',
        };
      case ArtifactType.TEXT_FILE:
        return {
          type: ArtifactType.TEXT_FILE,
          name: 'Text File',
          description: 'A text file or document',
          icon: 'file-text',
        };
      default:
        return {
          type: ArtifactType.FILE,
          name: 'Unknown',
          description: 'Unknown artifact type',
          icon: 'file',
        };
    }
  }
}
