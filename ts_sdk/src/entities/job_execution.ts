import type { EntityMerge } from '../IEntity';
import { APIEntity, registerEntity, dataManager } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models';
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

// `implements IJobExecution` only checks the class; it contributes no members, so every
// field declared solely on IJobExecution read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JobExecution extends EntityMerge<IJobExecution> {}

@registerEntity
export class JobExecution extends APIEntity<JobExecution> implements IJobExecution {
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
  external_function_id?: string;
  static type: string = 'job_execution';

  constructor(entity: Partial<IJobExecution> = {}) {
    super(entity);
    this.job_id = entity.job_id || '';
    if (entity.status && typeof entity.status === 'string') {
      this.status = (Object.values(JobExecutionStatus) as string[]).includes(entity.status)
        ? entity.status
        : JobExecutionStatus.UNKNOWN;
    } else {
      this.status = entity.status || JobExecutionStatus.NEW;
    }
    this.started_at = entity.started_at ? new Date(entity.started_at) : null;
    this.completed_at = entity.completed_at ? new Date(entity.completed_at) : null;
    this.duration_seconds = entity.duration_seconds ?? null;
    this.exit_code = entity.exit_code ?? null;
    this.error_message = entity.error_message ?? null;
    this.returned_value = entity.returned_value;
    this.job_execution_provider_id = entity.job_execution_provider_id ?? null;
    this.params = entity.params ?? null;
  }

  get isRunning(): boolean {
    return this.status === JobExecutionStatus.RUNNING;
  }

  get isCompleted(): boolean {
    return (
      this.status === JobExecutionStatus.COMPLETED ||
      this.status === JobExecutionStatus.ERROR ||
      this.status === JobExecutionStatus.TIMEOUT ||
      this.status === JobExecutionStatus.CANCELED ||
      this.status === JobExecutionStatus.TERMINATED
    );
  }

  async stop(): Promise<JobExecution> {
    try {
      const actionInfo = new ActionInfo('stop', this.getType(), this.id, 'POST');
      actionInfo.bodyParameters = {};
      const response = await dataManager.callAction<undefined, APIEntity<JobExecution>>(actionInfo);
      console.log('stoped job', response);
      return new JobExecution(response);
    } catch (e: any) {
      console.error('Failed to stop job: ', e);
      throw e;
    }
  }

  async execute(): Promise<JobExecution> {
    try {
      const actionInfo = new ActionInfo('execute', this.getType(), this.id, 'POST');
      actionInfo.bodyParameters = {};
      const response = await dataManager.callAction<undefined, APIEntity<JobExecution>>(actionInfo);
      console.log('executed job', response);
      // Convert APIEntity<JobExecution> to JobExecution instance
      return new JobExecution(response);
    } catch (e: any) {
      console.error('Failed to execute job: ', e);
      throw e;
    }
  }

  async getStatus(): Promise<JobExecutionStatus> {
    const actionInfo = new ActionInfo('get_status', this.getType(), this.id, 'GET');
    const response = await dataManager.callAction<void, JobExecutionStatus>(actionInfo);
    console.log('status job', response);
    return response;
  }

  async getLogs(): Promise<string> {
    const actionInfo = new ActionInfo('get_logs', this.getType(), this.id, 'GET');
    const response = await dataManager.callAction<void, string>(actionInfo);
    console.log('logs job', response);
    return response;
  }
}

//   // Static methods for job management
//   static async execute_job(name: string, params: any): Promise<Job> {
//     const actionInfo = new ActionInfo('execute_job');
//     actionInfo.method = 'POST';
//     actionInfo.bodyParameters = { name, params };

//     const response = await dataManager.callAction(actionInfo);
//     return new Job(response);
//   }

//   // Instance methods for job control
//   async start(): Promise<Job> {
//     const actionInfo = new ActionInfo('job_start');
//     actionInfo.method = 'PUT';
//     actionInfo.actionUrl = `/api/graph/job/${this.id}/start`;

//     const response = await dataManager.callAction(actionInfo);
//     return new Job(response as Partial<Job>);
//   }

//   async download() {
//     try {
//       const actionInfo = new ActionInfo('stop', 'job_execution', this.id, 'PUT', true, false, null, 'blob');
//       const response = await dataManager.callAction<void, Blob>(actionInfo);
//       console.log('stoped job', response);
//       return response;
//     } catch (e: any) {
//       console.error('Failed to stop job: ', e);
//       throw e;
//     }
//   }

//   async stop(): Promise<Job> {
//     const actionInfo = new ActionInfo('job_stop');
//     actionInfo.method = 'PUT';
//     actionInfo.actionUrl = `/api/graph/job/${this.id}/stop`;

//     const response = await dataManager.callAction(actionInfo);
//     return new Job(response as Partial<Job>);
//   }

//   async getLogs(): Promise<string> {
//     const actionInfo = new ActionInfo('job_logs');
//     actionInfo.method = 'GET';
//     actionInfo.actionUrl = `/api/graph/job/${this.id}/logs`;

//     const response = await dataManager.callAction(actionInfo);
//     return (response as any).logs || '';
//   }

//   async delete(): Promise<void> {
//     await dataManager.delete(this.typeId);
//   }

//   // Helper methods
//   get displayName(): string {
//     return this.execution_title || this.job_type || `Job ${this.id}`;
//   }

//   get isRunning(): boolean {
//     return this.status === JobExecutionStatus.RUNNING;
//   }

//   get isCompleted(): boolean {
//     return (
//       this.status === JobExecutionStatus.COMPLETED ||
//       this.status === JobExecutionStatus.ERROR ||
//       this.status === JobExecutionStatus.TIMEOUT ||
//       this.status === JobExecutionStatus.CANCELED ||
//       this.status === JobExecutionStatus.TERMINATED
//     );
//   }

//   get progressPercentage(): number {
//     return this.progress?.progress || 0;
//   }
// }
