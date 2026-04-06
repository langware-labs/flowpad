from datetime import datetime
from typing import Any, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.enums.job_enums import JobRunnerType, JobExecutionStatus, get_job_runner
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.responses import ApiFailResponse, ApiResponse


class JobExecution(Entity):
    type: str = APIField(default=BuiltinEntityType.JOB_EXECUTION.value)

    # Reference to the parent Job
    job_id: str = APIField(description="ID of the Job this execution belongs to")

    # Execution metadata
    status: JobExecutionStatus = APIField(
        default=JobExecutionStatus.NEW.value, description="Current status of this execution"
    )

    # Timing information
    started_at: Optional[datetime] = APIField(default=None, description="When the execution started")
    completed_at: Optional[datetime] = APIField(default=None, description="When the execution completed")
    duration_seconds: Optional[float] = APIField(default=None, description="Total execution duration in seconds")

    # Execution results
    exit_code: Optional[str] = APIField(default=None, description="Exit code from the execution")
    error_message: Optional[str] = APIField(default=None, description="Error message if execution failed")
    returned_value: Optional[Any] = APIField(default=None, description="Value returned by the job execution")

    # Job runner information (provider/driver pattern like ComputeNode)
    job_execution_provider_id: Optional[str] = APIField(default=None, description="ID from the job runner system")
    job_provider_type: Optional[JobRunnerType] = APIField(default=None, description="Type of job runner (local, gcp)")

    # Parameters for execution
    params: Optional[dict] = APIField(default=None, description="Parameters for the execution")

    @property
    def job_runner(self):
        """Get job runner instance (similar to ComputeNode.compute_provider)"""
        if self.job_provider_type is None:
            raise RuntimeError("Job provider type is not set")
        return get_job_runner(self.job_provider_type)

    @property
    def verified_job_runner_id(self) -> str:
        """Get verified job runner ID (similar to ComputeNode.verified_node_provider_id)"""
        if self.job_execution_provider_id is None:
            raise RuntimeError("Job runner ID is not set")
        return self.job_execution_provider_id

    @action.all(methods=["GET"])
    async def get_status(self) -> ApiResponse[JobExecutionStatus]:
        """Get current execution status using runner API"""
        if not self.job_execution_provider_id or not self.job_provider_type:
            return ApiResponse.success(self.status)

        try:
            current_status = await self.job_runner.get_execution_status(self.job_execution_provider_id)

            # Update local status if changed
            if current_status != self.status:
                self.status = current_status
                await self.save()

            return ApiResponse.success(current_status)

        except Exception as e:
            return ApiResponse.error(f"Error getting execution status: {str(e)}")

    @action.all(methods=["GET"])
    async def get_logs(self) -> ApiResponse[str]:
        """Get execution logs using runner API"""
        if not self.job_execution_provider_id or not self.job_provider_type:
            return ApiFailResponse(message="get logs: Missing execution", status_code=404)

        try:
            logs = await self.job_runner.get_execution_logs(self.job_execution_provider_id)
            return ApiResponse.success(logs)

        except Exception as e:
            return ApiResponse.error(f"Error getting execution logs: {str(e)}")

    @action.all(methods=["POST"])
    async def stop(self) -> ApiResponse["JobExecution"]:
        """Stop the execution using runner API"""
        if not self.job_execution_provider_id or not self.job_provider_type:
            return ApiFailResponse(message="No running execution to stop", status_code=404)

        try:
            stopped = await self.job_runner.stop_execution(self.job_execution_provider_id)

            if stopped:
                # Update status from runner
                current_status = await self.job_runner.get_execution_status(self.job_execution_provider_id)
                self.status = current_status
                await self.save()

                return ApiResponse.success(self)
            else:
                return ApiResponse.error("Failed to stop execution")

        except Exception as e:
            return ApiResponse.error(f"Error stopping execution: {str(e)}")

    @action.all(methods=["DELETE"])
    async def cleanup(self) -> ApiResponse[bool]:
        """Clean up execution resources using runner API"""
        if not self.job_execution_provider_id or not self.job_provider_type:
            return ApiResponse.success(True)

        try:
            cleaned = await self.job_runner.cleanup_execution(self.job_execution_provider_id)

            # Clear runner fields after cleanup
            self.job_execution_provider_id = None
            await self.save()

            return ApiResponse.success(cleaned)

        except Exception as e:
            return ApiResponse.error(f"Error cleaning up execution: {str(e)}")

    async def get_result(self):
        """Get complete execution result using runner API"""
        if not self.job_execution_provider_id or not self.job_provider_type:
            return None

        try:
            result = await self.job_runner.get_execution_result(self.job_execution_provider_id)

            # Update local state with result data
            self.status = result.worker_status
            self.exit_code = result.exit_code
            self.error_message = result.error_message
            self.returned_value = result.returned_value
            self.started_at = result.started_at
            self.completed_at = result.completed_at
            self.duration_seconds = result.duration_seconds

            await self.save()
            return result

        except Exception:
            return None

    async def wait_for_completion(self, timeout_seconds: Optional[int] = None) -> bool:
        """Wait for execution to complete using runner API"""
        if not self.job_execution_provider_id or not self.job_provider_type:
            return False

        try:
            return await self.job_runner.wait_for_execution_completion(self.job_execution_provider_id, timeout_seconds)
        except Exception:
            return False
