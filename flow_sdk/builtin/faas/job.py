from typing import Any, Dict, List, Optional, Type, cast

from pydantic import BaseModel

from flow_sdk.config import default_service_config
from flow_sdk.api.api_types.api_field import APIField, EntityField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.enums.job_enums import JobRunnerType, JobDeploymentStatus, JobExecutionStatus, JobType, JobRunner, get_job_runner
from flow_sdk.builtin.faas.job_execution import JobExecution
from flow_sdk.core import Entity, ExpressionNode, QueryFilter, QueryOp, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses import ApiFailResponse, ApiResponse


class JobConfig(BaseModel):
    jwt: Optional[str]  # JWT forwarded from the user
    env_vars: Optional[dict] = None  # Environment variables like API keys


class ExecutionInfo(BaseModel):
    """Parameters for job execution"""

    params: Optional[Dict[str, Any]] = None  # Runtime parameters for the job execution


class Job(Entity):
    type: str = APIField(default=BuiltinEntityType.JOB.value)
    deployment_status: Optional[JobDeploymentStatus] = APIField(
        default=JobDeploymentStatus.NEW.value
    )  # Job definition status
    job_type: JobType = EntityField(default=JobType.SYSTEM)  # Type of job, defaulting to SYSTEM

    # Job runner fields
    job_provider_type: Optional[JobRunnerType] = None  # The type of job runner (local, gcp)
    job_name: Optional[str] = APIField(default=None)  # The name of the job to execute
    job_description: Optional[str] = APIField(default=None)  # The description of the job to execute
    timeout_seconds: Optional[int] = APIField(default=None)  # Job timeout in seconds
    auto_deploy: bool = APIField(default=False)  # Auto-deploy if job doesn't exist

    env_vars: Optional[dict] = APIField(default=None)  # Environment variables for execution

    # Tzahi
    # add action that is override get job (LIST, get all) , it retuns all JOB I have access to + System jobs
    # use the SystemJob.to_api_job, we do not expose the SystemJob directly
    # add action called "system_job_execute" that executes the system job BY NAME, it's a generic action that not under the job entity
    # system job name is unique
    # note, the job invokation method in Typescript LOOK exactly the same as the job execution method, so we can use the same code for both, the only differenct is the url endpoing
    # system job invokation : /api/v1/system_job_execute/<system_job_name>, other job execution: /api/v1/job/<job_id>execute
    # both returning execution object.
    # When I am executing a job, I am NOT the owner of the JobExecution, the JobExecution is a child of the Job, so the owner is the Job, not the user that executed it.
    # When I am executing a Job, I Get Viewer role on the job. allowing my to see the basic execution info only.
    # make sure to add negative tests, that system jobs can not be read, user can create execution of system jobs, but can not read them, user can not access logs.
    # make sure job folder is available, or throw warning in backend logfire, not share iwth with front.

    @action.all(methods=["POST"])
    async def execute(self, execution_info: Optional[ExecutionInfo] = None) -> ApiResponse[JobExecution]:
        """Execute action that creates and returns JobExecution object"""
        try:
            request_info = get_current_request_info()
            if request_info is None:
                return ApiResponse.error("Failed to execute job: No request context found")

            # Extract execution parameters
            execution_params = None
            if execution_info and execution_info.params:
                execution_params = execution_info.params

            import logging

            logging.error(f"[DEBUG] JOB.execute: execution_info={execution_info}")
            logging.error(f"[DEBUG] JOB.execute: execution_params={execution_params}")

            job_execution = await self.execute_job(request_info.user.typeid, execution_params)
            return ApiResponse.success(job_execution)
        except ValueError as e:
            # Validation errors like "Job name is required"
            return ApiFailResponse(message=f"Failed to execute job: {str(e)}", status_code=400)
        except RuntimeError as e:
            # Check if it's a "not found" error or server error
            error_msg = str(e)
            if "does not exist" in error_msg.lower() or "not found" in error_msg.lower():
                return ApiFailResponse(message=f"Failed to execute job: {error_msg}", status_code=404)
            else:
                return ApiFailResponse(message=f"Failed to execute job: {error_msg}", status_code=500)
        except Exception as e:
            # Generic server errors
            return ApiFailResponse(message=f"Failed to execute job: {str(e)}", status_code=500)

    @property
    def config_job_runner_type(self) -> JobRunnerType:
        # Get job provider type from environment variable
        job_provider_type_config = default_service_config.job_runner_type
        # Convert to uppercase for enum lookup
        config_upper = job_provider_type_config.upper()
        if config_upper not in JobRunnerType.__members__:
            raise RuntimeError(f"Invalid job provider type: {job_provider_type_config}")
        job_provider_type: JobRunnerType = JobRunnerType.__members__[config_upper]
        if job_provider_type == JobRunnerType.LOCAL and not default_service_config.development:
            raise RuntimeError("Local job runner is only available in development mode")
        return job_provider_type

    @property
    def job_runner(self) -> JobRunner:
        if self.job_provider_type is None:
            raise RuntimeError("Job provider type is not set")
        return get_job_runner(self.job_provider_type)

    @classmethod
    async def get_all(
        cls: Type["Job"],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> List["Job"]:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        entities_filter = entities_filter or QueryFilter(type=cls.get_type())
        user_jobs = await super().get_all(entities_filter=entities_filter, source_entity=source_entity)

        # Only add system jobs when querying for Job type (not SystemJob)
        # SystemJob should not merge additional system jobs as it's already querying system jobs directly
        if cls.get_type() == BuiltinEntityType.JOB.value:
            # Get system jobs
            system_jobs = await cls.get_system_jobs()

            # Deduplicate using set based on entity ID
            user_jobs_set = {job.id: job for job in user_jobs}
            system_jobs_set = {job.id: job for job in system_jobs}

            # Merge the sets and return values
            merged_jobs = {**user_jobs_set, **system_jobs_set}
            return cast(List[Job], list(merged_jobs.values()))

        return cast(List[Job], user_jobs)

    @classmethod
    async def get_system_jobs(cls) -> List["Job"]:
        """Get all system jobs"""
        expression_node = ExpressionNode(op=QueryOp.EQ, operands=["allowed_api_execution", True])
        filter = QueryFilter(type=BuiltinEntityType.SYSTEM_JOB.value, match=expression_node)
        system_jobs = await super().get_all(entities_filter=filter)
        user_visible_jobs = [s_job.to_api_job() for s_job in system_jobs]
        return user_visible_jobs

    async def execute_job(
        self, owner_typeid: TypeId, execution_params: Optional[Dict[str, Any]] = None
    ) -> JobExecution:
        """Internal method to execute job and return JobExecution object"""
        # Validate required fields
        if not self.job_name:
            raise ValueError("Job name is required to execute job")

        # Set provider type from config if not set
        if not self.job_provider_type:
            self.job_provider_type = self.config_job_runner_type

        # Check if job exists, deploy if needed
        job_runner_id = await self.job_runner.get_system_job_runner_id(self.job_name)
        job_exists = await self.job_runner.is_job_exist(job_runner_id)

        if not job_exists:
            if self.auto_deploy:
                # Auto-deploy the job
                await self.deploy_job_if_needed()
            else:
                # Job doesn't exist and auto-deploy is false
                raise RuntimeError(
                    f"Job '{self.job_name}' does not exist. Set auto_deploy=True to deploy automatically."
                )

        # Execute job and get runner execution ID
        job_execution_provider_id = await self.job_runner.create_system_job_execution(
            system_job_name=self.job_name, params=execution_params
        )

        job_execution = JobExecution(
            job_id=self.id,
            status=JobExecutionStatus.LAUNCHED,
            job_execution_provider_id=job_execution_provider_id,
            job_provider_type=self.job_provider_type,
            params=execution_params,
        )

        await job_execution.save(owner_typeid)

        # Update Job status to deployed
        self.deployment_status = JobDeploymentStatus.DEPLOYED
        await self.save()

        return job_execution

    # Clean API: Job only provides execute action
    # All execution operations should use JobExecution entity

    # Job-specific methods (for job deployment status using job_name)
    async def get_job_deployment_status(self) -> JobDeploymentStatus:
        """Get the current job deployment status"""
        if not self.job_name:
            raise RuntimeError("Job name is required to get deployment status")
        return await self.job_runner.get_job_status(self.job_name)

    async def deploy_job_if_needed(self, config: Optional[dict] = None) -> bool:
        """Deploy the job if it's not already deployed"""
        if not self.job_name:
            raise RuntimeError("Job name is required to deploy")

        try:
            current_status = await self.get_job_deployment_status()
            if current_status == JobDeploymentStatus.DEPLOYED:
                return True

            # Deploy the job
            return await self.job_runner.deploy_job(self.job_name, config)
        except Exception:
            # If we can't get status, try to deploy
            return await self.job_runner.deploy_job(self.job_name, config)

    async def wait_for_job_deployed(self, timeout_seconds: Optional[int] = None) -> bool:
        """Wait for the job to be deployed"""
        if not self.job_name:
            raise RuntimeError("Job name is required to wait for deployment")
        return await self.job_runner.wait_for_job_deployed(self.job_name, timeout_seconds)
