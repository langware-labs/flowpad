export enum JobExecutionStatus {
  /** Execution is newly created */
  NEW = 'new',
  /** Execution has been launched */
  LAUNCHED = 'launched',
  /** Execution is actively running */
  RUNNING = 'running',
  /** Execution completed successfully */
  COMPLETED = 'completed',
  /** Execution timed out */
  TIMEOUT = 'timeout',
  /** Execution failed with an error */
  ERROR = 'error',
  /** Execution was canceled */
  CANCELED = 'canceled',
  /** Monitor shutdown signal */
  TERMINATING = 'terminating',
  /** Monitor has terminated */
  TERMINATED = 'terminated',
  /** Unknown status */
  UNKNOWN = 'unknown',
}

export enum JobFilter {
  ALL = 'all',
  RUNNING = 'running',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export enum JobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum JobDeploymentStatus {
  /** Job is newly created */
  NEW = 'new',
  /** Job is deploying */
  DEPLOYING = 'deploying',
  /** Job has been deployed */
  DEPLOYED = 'deployed',
  /** Job deployment failed */
  DEPLOYMENT_ERROR = 'deployment_error',
}

export enum JobRunnerType {
  LOCAL = 'local',
  GCP = 'gcp',
  // Add more as needed
}

export enum JobType {
  SYSTEM = 'system',
  USER = 'user',
}
