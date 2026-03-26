from flow_sdk._compat import StrEnum


class JobRunnerType(StrEnum):
    GCP = "gcp"
    LOCAL = "local"


class JobExecutionStatus(StrEnum):
    NEW = "new"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobDeploymentStatus(StrEnum):
    NEW = "new"
    DEPLOYED = "deployed"
    ARCHIVED = "archived"


class JobType(StrEnum):
    CRON = "cron"
    WEBHOOK = "webhook"
    MANUAL = "manual"
    SYSTEM = "system"


# Stub for JobRunner since core.faas.jobs.runners module doesn't exist in flow-cli
class JobRunner:
    """Stub JobRunner class for job execution."""
    pass


def get_job_runner(job_type):
    """Stub function for getting job runner by type."""
    return JobRunner()
