export enum CodebaseReferenceType {
  FILE = 'FILE',
  FOLDER = 'FOLDER',
  GLOB = 'GLOB',
  REFERENCE = 'REFERENCE', // External reference (URLs, etc.)
  URL = 'URL',
}

// Legacy alias for backward compatibility
export const ArtifactReferenceType = CodebaseReferenceType;

export enum ArtifactType {
  WEBPAGE = 'WEBPAGE',
  FUNCTION = 'FUNCTION',
  APP_SERVICE = 'APP_SERVICE',
  CLOUD_SERVICE = 'CLOUD_SERVICE',
  FILE = 'FILE',
  DATA = 'DATA',
  TEXT_FILE = 'TEXT_FILE',
  WEBAPP = 'WEBAPP',
}

export enum ArtifactRelationType {
  TEST_OF = 'test_of',
  IMPLEMENTATION_OF = 'implementation_of',
  DEPENDS_ON = 'depends_on',
  CONTAINS = 'contains',
  REFERENCES = 'references',
}
