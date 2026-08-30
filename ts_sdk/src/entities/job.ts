import { APIEntity, registerEntity } from '../APIEntity';
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

// `implements IJob` only checks the class; it contributes no members, so every
// field declared solely on IJob read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Job extends Omit<IJob, 'expand' | 'id' | 'is_private' | 'members'> {}

@registerEntity
export class Job extends APIEntity<Job> implements IJob {
  deployment_status: JobDeploymentStatus = JobDeploymentStatus.NEW;
  job_type?: JobType;
  job_provider_type?: JobRunnerType;
  job_name?: string;
  job_description?: string;
  timeout_seconds?: number;
  auto_deploy?: boolean = false;
  env_vars?: Record<string, string>;
  static type: string = 'job';

  constructor(entity: Partial<IJob> = {}) {
    super(entity);
    this.deployment_status = entity.deployment_status || JobDeploymentStatus.NEW;
    this.job_type = entity.job_type || JobType.SYSTEM;
    this.job_provider_type = entity.job_provider_type || JobRunnerType.LOCAL;
    this.job_name = entity.job_name || '';
    this.job_description = entity.job_description || '';
    this.timeout_seconds = entity.timeout_seconds || 3600;
    this.auto_deploy = entity.auto_deploy || false;
    this.env_vars = entity.env_vars || {};
  }
}
