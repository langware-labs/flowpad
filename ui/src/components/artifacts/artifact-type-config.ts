import { ArtifactType, CodebaseReferenceType } from '@sdk';
import { Cloud, Code, Database, FileText, Globe, LayoutDashboard, LucideIcon } from 'lucide-react';

/**
 * Metadata field definition for artifact forms
 */
export interface MetadataFieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea';
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  description?: string;
}

/**
 * Configuration for each artifact type
 */
export interface ArtifactTypeConfig {
  type: ArtifactType;
  label: string;
  description: string;
  icon: LucideIcon;
  color: string;
  defaultRefType: CodebaseReferenceType;
  /** Metadata fields specific to this artifact type */
  metadataFields: MetadataFieldDef[];
}

/**
 * Artifact type configurations with metadata schemas
 */
export const ARTIFACT_TYPE_CONFIGS: Record<ArtifactType, ArtifactTypeConfig> = {
  [ArtifactType.WEBAPP]: {
    type: ArtifactType.WEBAPP,
    label: 'Web App',
    description: 'A running web application accessible via browser',
    icon: Globe,
    color: 'text-teal-500',
    defaultRefType: CodebaseReferenceType.FOLDER,
    metadataFields: [
      {
        key: 'port',
        label: 'Port',
        type: 'number',
        placeholder: '3000',
        required: true,
        description: 'Port number where the web app is running',
      },
      {
        key: 'start_cmd',
        label: 'Start Command',
        type: 'text',
        placeholder: 'npm run dev',
        description: 'Command to start/restart the service',
      },
      {
        key: 'health',
        label: 'Health Endpoint',
        type: 'text',
        placeholder: '/',
        description: 'Health check endpoint path',
      },
    ],
  },
  [ArtifactType.APP_SERVICE]: {
    type: ArtifactType.APP_SERVICE,
    label: 'App Service',
    description: 'An application service or microservice component',
    icon: LayoutDashboard,
    color: 'text-orange-500',
    defaultRefType: CodebaseReferenceType.FOLDER,
    metadataFields: [
      {
        key: 'port',
        label: 'Port',
        type: 'number',
        placeholder: '8080',
        required: true,
        description: 'Port number where the service is running',
      },
      {
        key: 'start_cmd',
        label: 'Start Command',
        type: 'text',
        placeholder: 'python main.py',
        description: 'Command to start/restart the service',
      },
      {
        key: 'health',
        label: 'Health Endpoint',
        type: 'text',
        placeholder: '/health',
        description: 'Health check endpoint path',
      },
    ],
  },
  [ArtifactType.FILE]: {
    type: ArtifactType.FILE,
    label: 'File',
    description: 'A general file or document',
    icon: FileText,
    color: 'text-blue-500',
    defaultRefType: CodebaseReferenceType.FILE,
    metadataFields: [],
  },
  [ArtifactType.TEXT_FILE]: {
    type: ArtifactType.TEXT_FILE,
    label: 'Text File',
    description: 'A text file or document',
    icon: FileText,
    color: 'text-slate-500',
    defaultRefType: CodebaseReferenceType.FILE,
    metadataFields: [],
  },
  [ArtifactType.WEBPAGE]: {
    type: ArtifactType.WEBPAGE,
    label: 'Webpage',
    description: 'A web page or web-based UI',
    icon: Globe,
    color: 'text-green-500',
    defaultRefType: CodebaseReferenceType.FILE,
    metadataFields: [
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        placeholder: 'https://example.com',
        description: 'URL of the webpage',
      },
    ],
  },
  [ArtifactType.FUNCTION]: {
    type: ArtifactType.FUNCTION,
    label: 'Function',
    description: 'A reusable function or method',
    icon: Code,
    color: 'text-purple-500',
    defaultRefType: CodebaseReferenceType.FILE,
    metadataFields: [
      {
        key: 'function_name',
        label: 'Function Name',
        type: 'text',
        placeholder: 'myFunction',
      },
      {
        key: 'language',
        label: 'Language',
        type: 'select',
        options: [
          { value: 'python', label: 'Python' },
          { value: 'javascript', label: 'JavaScript' },
          { value: 'typescript', label: 'TypeScript' },
          { value: 'other', label: 'Other' },
        ],
      },
    ],
  },
  [ArtifactType.CLOUD_SERVICE]: {
    type: ArtifactType.CLOUD_SERVICE,
    label: 'Cloud Service',
    description: 'A cloud-hosted service or infrastructure',
    icon: Cloud,
    color: 'text-cyan-500',
    defaultRefType: CodebaseReferenceType.REFERENCE,
    metadataFields: [
      {
        key: 'provider',
        label: 'Cloud Provider',
        type: 'select',
        options: [
          { value: 'aws', label: 'AWS' },
          { value: 'gcp', label: 'Google Cloud' },
          { value: 'azure', label: 'Azure' },
          { value: 'other', label: 'Other' },
        ],
      },
      {
        key: 'service_type',
        label: 'Service Type',
        type: 'text',
        placeholder: 'Lambda, Cloud Function, etc.',
      },
    ],
  },
  [ArtifactType.DATA]: {
    type: ArtifactType.DATA,
    label: 'Data',
    description: 'Raw data, dataset, or structured data output',
    icon: Database,
    color: 'text-indigo-500',
    defaultRefType: CodebaseReferenceType.FILE,
    metadataFields: [
      {
        key: 'format',
        label: 'Data Format',
        type: 'select',
        options: [
          { value: 'json', label: 'JSON' },
          { value: 'csv', label: 'CSV' },
          { value: 'xml', label: 'XML' },
          { value: 'parquet', label: 'Parquet' },
          { value: 'other', label: 'Other' },
        ],
      },
    ],
  },
};

/**
 * Get configuration for an artifact type
 */
export function getArtifactTypeConfig(type: ArtifactType): ArtifactTypeConfig {
  return ARTIFACT_TYPE_CONFIGS[type] || ARTIFACT_TYPE_CONFIGS[ArtifactType.FILE];
}

/**
 * Get all artifact types as options for a select
 */
export function getArtifactTypeOptions(): { value: ArtifactType; label: string }[] {
  return Object.values(ARTIFACT_TYPE_CONFIGS).map((config) => ({
    value: config.type,
    label: config.label,
  }));
}
