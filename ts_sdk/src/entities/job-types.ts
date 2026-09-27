/**
 * The wire shape of a job row, separate from the Job class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';
import { JobType, JobDeploymentStatus, JobRunnerType } from './jobs_enum';

export interface IJob extends IEntity {
  deployment_status: JobDeploymentStatus;
  job_type?: JobType;
  job_provider_type?: JobRunnerType;
  job_name?: string;
  job_description?: string;
  timeout_seconds?: number;
  auto_deploy?: boolean;
  env_vars?: Record<string, string>;
}
