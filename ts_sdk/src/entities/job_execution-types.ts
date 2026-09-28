/**
 * The wire shape of a job execution row, separate from the JobExecution class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';
import { JobExecutionStatus, JobRunnerType } from './jobs_enum';

export interface IJobExecution extends IEntity {
  job_id: string;
  status: JobExecutionStatus;
  started_at?: Date | null;
  completed_at?: Date | null;
  duration_seconds?: number | null;
  exit_code?: string | null;
  error_message?: string | null;
  returned_value?: any;
  job_execution_provider_id?: string | null;
  job_provider_type?: JobRunnerType | null;
  params?: Record<string, any> | null;
}
