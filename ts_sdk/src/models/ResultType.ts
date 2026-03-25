/**
 * Types of results that can be produced by an AI agent or flow.
 * Matches the Python ResultType enum in semantic_analyzer.py
 */
export enum ResultType {
  /** Web page or web application */
  WEBPAGE = 'webpage',
  /** Function or code implementation */
  FUNCTION = 'function',
  /** Application service or API */
  APP_SERVICE = 'app_service',
  /** Cloud service or infrastructure */
  CLOUD_SERVICE = 'cloud_service',
  /** Report or analysis document */
  REPORT = 'report',
  /** File or document */
  FILE = 'file',
  /** Data structure or dataset */
  DATA = 'data',
  /** Git repository */
  GIT_REPO = 'git_repo',
  /** Text file or document */
  TEXT_FILE = 'text_file',
  /** Running web application on a port */
  WEBAPP = 'webapp',
}

/**
 * Metadata for each result type
 */
export interface ResultTypeInfo {
  /** The result type enum value (unique key) */
  type: ResultType;
  /** One-liner description of what this result means */
  description: string;
  /** Icon name (using Lucide icons or similar icon library) */
  icon: string;
}

/**
 * Detailed information for each ResultType
 * Key is the ResultType enum value, value contains metadata
 */
export const ResultTypeMetadata: Record<ResultType, ResultTypeInfo> = {
  [ResultType.WEBPAGE]: {
    type: ResultType.WEBPAGE,
    description: 'Interactive web page or web application with UI components',
    icon: 'Globe',
  },
  [ResultType.FUNCTION]: {
    type: ResultType.FUNCTION,
    description: 'Executable function or code implementation',
    icon: 'Code',
  },
  [ResultType.APP_SERVICE]: {
    type: ResultType.APP_SERVICE,
    description: 'Application service endpoint or API integration',
    icon: 'Server',
  },
  [ResultType.CLOUD_SERVICE]: {
    type: ResultType.CLOUD_SERVICE,
    description: 'Cloud infrastructure service or deployment configuration',
    icon: 'Cloud',
  },
  [ResultType.REPORT]: {
    type: ResultType.REPORT,
    description: 'Analysis report or documentation with insights and findings',
    icon: 'FileText',
  },
  [ResultType.FILE]: {
    type: ResultType.FILE,
    description: 'File or document created in the filesystem',
    icon: 'File',
  },
  [ResultType.DATA]: {
    type: ResultType.DATA,
    description: 'Structured data, dataset, or data transformation output',
    icon: 'Database',
  },
  [ResultType.GIT_REPO]: {
    type: ResultType.GIT_REPO,
    description: 'Git repository with version-controlled code',
    icon: 'GitBranch',
  },
  [ResultType.TEXT_FILE]: {
    type: ResultType.TEXT_FILE,
    description: 'Text file or document',
    icon: 'FileText',
  },
  [ResultType.WEBAPP]: {
    type: ResultType.WEBAPP,
    description: 'Running web application accessible via browser',
    icon: 'Layout',
  },
};

/**
 * User Prompt Analysis structure matching backend model
 */
export interface UserPromptAnalysis {
  /** Original user prompt */
  user_prompt?: string;
  /** Main goal extracted from prompt */
  goal: string;
  /** Keywords extracted from the user prompt */
  keywords: string[];
  /** Semantic labels matching ontology */
  labels: string[];
  /** Expected result types from the prompt */
  expected_result_types: string[];
  /** Whether the prompt requires a simple answer */
  simple_answer: boolean;
}

/**
 * Goal focus event data for streaming user prompt analysis (LEGACY - for backward compatibility)
 */
export interface GoalFocusArgs {
  /** The main goal */
  goal: string;
  /** Comma-separated keywords */
  keywords: string;
  /** Comma-separated semantic labels */
  labels: string;
  /** Comma-separated expected result types */
  expected_result_types: string;
}

/**
 * Prompt Analysis focus event data containing the complete analysis
 */
export interface PromptAnalysisFocusArgs {
  /** The complete user prompt analysis */
  user_prompt_analysis: UserPromptAnalysis;
}

/**
 * Alias for GoalFocusArgs to match naming in components (LEGACY)
 */
export type GoalData = GoalFocusArgs;

/**
 * Type for prompt analysis data containing the complete analysis (for flow state)
 */
export type PromptAnalysisData = PromptAnalysisFocusArgs;
