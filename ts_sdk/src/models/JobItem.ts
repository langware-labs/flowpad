import { Job } from '../entities/job';
import { JobExecution } from '../entities/job_execution';

export interface JobCounts {
  total: number;
  running: number;
  completed: number;
  failed: number;
}

// Merge type for JobListItem that combines Job and JobExecution data
export interface JobItem {
  id: string;
  jobId: string;
  title: string;
  jobType: string;
  status:
    | 'running'
    | 'launched'
    | 'completed'
    | 'error'
    | 'terminated'
    | 'terminating'
    | 'canceled'
    | 'timeout'
    | 'new';
  progress?: number;
  createdAt: Date;
  updatedAt: Date;
  result?: any;
  error?: string;
}

// Utility function to merge Job and JobExecution data
export function mergeJobWithExecution(job: Job, jobExecution: JobExecution): JobItem {
  return {
    id: jobExecution.id,
    jobId: job.id,
    title: job.job_name!,
    jobType: job.job_type!,
    status: jobExecution.status as
      | 'running'
      | 'launched'
      | 'completed'
      | 'error'
      | 'terminated'
      | 'terminating'
      | 'canceled'
      | 'timeout'
      | 'new',
    createdAt: jobExecution.created_date!,
    updatedAt: jobExecution.updated_date!,
    result: jobExecution.returned_value,
    error: jobExecution.error_message ?? undefined,
  };
}
