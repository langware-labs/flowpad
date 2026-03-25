import { dataManager } from '../APIEntity';
import { QueryFilter, QueryRequest, TypeId } from '../FlowSync';
import { Job } from '../entities/job';
import { IJobExecution, JobExecution } from '../entities/job_execution';
import { JobExecutionStatus } from '../entities/jobs_enum';
import { ActionInfo } from '../models';
import { JobItem, mergeJobWithExecution } from '../models/JobItem';

export interface JobFilters {
  status?: 'running' | 'completed' | 'failed' | 'all';
  limit?: number;
  offset?: number;
}

export class JobService {
  private static instance: JobService;

  static getInstance(): JobService {
    if (!JobService.instance) {
      JobService.instance = new JobService();
    }
    return JobService.instance;
  }

  listJobItems(jobList: Job[], jobExecutionList: JobExecution[]): JobItem[] {
    const jobItems: JobItem[] = [];

    jobExecutionList.forEach((jobExecution) => {
      let matchingJob = jobList.find((job) => jobExecution.job_id === job.id);
      if (!matchingJob) {
        matchingJob = jobList.find((job) => jobExecution.job_id === job.job_name);
      }
      if (matchingJob) {
        jobItems.push(mergeJobWithExecution(matchingJob, jobExecution));
      }
    });
    return jobItems;
  }

  // Job management
  async listJobs(filters?: JobFilters): Promise<Job[]> {
    try {
      let jobQueryFilter: QueryFilter | null = null;
      if (filters) {
        jobQueryFilter = new QueryFilter({
          limit: filters?.limit,
          offset: filters?.offset,
          match: filters.status ? { op: '$EQ', operands: ['status', filters.status] } : undefined,
        });
      }
      const request = new QueryRequest({
        type: 'job',
        query: jobQueryFilter,
        name: 'jobService listJobs query',
      });
      const jobs = await Job.query(request);
      return jobs;
    } catch (error) {
      console.error('Failed to list jobs:', error);
      return [];
    }
  }

  async listJobExecutions(filters?: JobFilters): Promise<JobExecution[]> {
    try {
      let jobQueryFilter: QueryFilter | null = null;
      if (filters) {
        jobQueryFilter = new QueryFilter({
          limit: filters?.limit,
          offset: filters?.offset,
          match: filters.status ? { op: '$EQ', operands: ['status', filters.status] } : undefined,
        });
      }
      const request = new QueryRequest({
        type: 'job_execution',
        query: jobQueryFilter,
        name: 'jobService listJobExecutions query',
      });
      const jobExecutions = await JobExecution.query(request);

      return jobExecutions;
    } catch (error) {
      console.error('Failed to list jobs:', error);
      return [];
    }
  }
  async systemJobExecutionList(): Promise<JobExecution[]> {
    try {
      const actionInfo = new ActionInfo('executed_system_job_list');
      actionInfo.method = 'GET';
      const response = await dataManager.callAction<undefined, JobExecution[]>(actionInfo);
      return response;
    } catch (e: any) {
      console.error('Failed to execute job: ', e);
      throw e;
    }
  }

  async getJobItem(jobExecutionId: string): Promise<JobItem | null> {
    const jobExecutionResult = await JobExecution.getById(jobExecutionId);
    if (!jobExecutionResult) {
      return null;
    }
    const jobResult = await Job.getById(jobExecutionResult.job_id);
    if (!jobResult) {
      return null;
    }
    return mergeJobWithExecution(jobResult, jobExecutionResult);
  }

  async getJob(job: Job): Promise<Job | null> {
    try {
      if (job.id === 'system_job') {
        return null;
        // TODO: Ask Eran
      } else {
        const jobTypeId = new TypeId(job.getType(), job.id);
        return await dataManager.getByTypeId<Job>(jobTypeId);
      }
    } catch (error) {
      console.error('Failed to get job:', error);
      return null;
    }
  }

  // Job control
  // Job execution
  async executeJob(job: Job, params: any): Promise<JobExecution> {
    try {
      let actionInfo: ActionInfo | null = null;
      if (job.id == 'system_job') {
        actionInfo = new ActionInfo('system_job_execute');
        actionInfo.method = 'POST';
        actionInfo.bodyParameters = {
          system_job_name: job.job_name,
        };
      } else {
        actionInfo = new ActionInfo('execute', job.getType(), job.id, 'POST');
        actionInfo.bodyParameters = params ?? {};
      }
      const response = await dataManager.callAction<undefined, IJobExecution>(actionInfo);
      // Convert APIEntity<JobExecution> to JobExecution instance
      return new JobExecution(response);
    } catch (e: any) {
      console.error('Failed to execute job: ', e);
      throw e;
    }
  }

  async stopJob(jobExecution: JobExecution): Promise<JobExecution> {
    try {
      if (jobExecution.job_id == 'system_job') {
        return jobExecution;
        // TODO: Ask Eran
      }
      const actionInfo = new ActionInfo('stop', jobExecution.getType(), jobExecution.id, 'PUT');
      const response = await dataManager.callAction<undefined, IJobExecution>(actionInfo);
      return new JobExecution(response);
    } catch (e: any) {
      console.error('Failed to stop job: ', e);
      throw e;
    }
  }

  async deleteJob(job: Job): Promise<void> {
    try {
      if (job.id == 'system_job') {
        return;
        // TODO: Ask Eran
      } else {
        await job.delete();
        return;
      }
    } catch (e: any) {
      console.error('Failed to delete job: ', e);
      throw e;
    }
  }

  // Job logs
  async getJobLogs(jobExecutionId: string): Promise<string> {
    try {
      const jobExecution = await JobExecution.getById(jobExecutionId);
      if (!jobExecution) {
        throw new Error('Job execution not found');
      }
      const actionInfo = new ActionInfo('get_logs', jobExecution.getType(), jobExecution.id, 'GET');
      const response = await dataManager.callAction<undefined, string>(actionInfo);
      return response;
    } catch (error) {
      console.error('Failed to get job logs:', error);
      return '';
    }
  }

  async getJobStatus(jobExecution: JobExecution): Promise<JobExecutionStatus> {
    try {
      if (jobExecution.job_id == 'system_job') {
        return JobExecutionStatus.UNKNOWN;
        // TODO: Ask Eran
      }
      const actionInfo = new ActionInfo('get_status', jobExecution.getType(), jobExecution.id, 'GET');
      const response = await dataManager.callAction<undefined, JobExecutionStatus>(actionInfo);
      return response;
    } catch (error) {
      console.error('Failed to get job status:', error);
      return JobExecutionStatus.UNKNOWN;
    }
  }

  // // Real-time subscriptions
  // subscribeToJob(jobId: string, callback: (job: Job | null) => void): () => void {
  //   const typeId = new TypeId('job', jobId);
  //   return dataContext.subscribe<Job>(typeId, callback, true);
  // }

  // subscribeToJobs(filters: JobFilters, callback: (jobs: Job[]) => void): () => void {
  //   return dataContext.watchQuery<Job>('job', filters ? { filters } : null, [], callback);
  // }

  // // Test job generation
  // async generateTestJob(type: 'pass' | 'fail' | 'hang'): Promise<Job> {
  //   const testParams = {
  //     pass: { duration: 2000, success: true },
  //     fail: { duration: 1000, success: false, error: 'Test failure' },
  //     hang: { duration: 30000, success: true },
  //   };

  //   try {
  //     return await this.executeJob(`test_${type}_job`, testParams[type]);
  //   } catch (error) {
  //     console.warn('Backend not available, generating mock job:', error);

  //     // Return a mock job for testing UI
  //     const mockJob = {
  //       id: `test-${type}-${Date.now()}`,
  //       status: type === 'fail' ? 'failed' : 'running',
  //       execution_title: `Test ${type} Job`,
  //       job_type: `test_${type}`,
  //       external_function_id: `func_${Date.now()}`,
  //       created_at: new Date(),
  //       updated_at: new Date(),
  //       error: type === 'fail' ? 'Test failure' : undefined,
  //       displayName: `Test ${type} Job`,
  //       isRunning: type !== 'fail',
  //       isCompleted: type === 'fail',
  //       progressPercentage: type === 'fail' ? 0 : 50,
  //     } as any;

  //     return mockJob;
  //   }
  // }
}

export const jobService = JobService.getInstance();
