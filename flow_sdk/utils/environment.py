import json
import os


def get_bool_env_var(var_name: str, default: bool) -> bool:
    """
    Fetches an environment variable and converts it to a boolean.
    """
    value = os.getenv(var_name, str(default)).strip().lower()
    return value in ["true", "1", "t", "y", "yes"]


def get_int_env_var(var_name: str, default: int) -> int:
    """
    Fetches an environment variable and converts it to an integer.
    """
    value = os.getenv(var_name, str(default)).strip()
    return int(value)


def get_float_env_var(var_name: str, default: float) -> float:
    """
    Fetches an environment variable and converts it to a float.
    """
    value = os.getenv(var_name, str(default)).strip()
    return float(value)


def get_str_list_env_var(var_name: str, default: list[str]) -> list[str]:
    """
    Fetches an environment variable and converts it to a list of strings.
    The environment variable should be a comma-separated string.
    """
    value = os.getenv(var_name)
    if value is None:
        return default
    return [item.strip() for item in value.split(",")]


def get_execution_scope() -> list:
    """Parse FLOWPAD_EXECUTION_SCOPE from environment."""
    rawValue = os.getenv("FLOWPAD_EXECUTION_SCOPE")
    if rawValue is None:
        return []
    try:
        return json.loads(rawValue)
    except json.JSONDecodeError:
        return []


#: The FlowCall run a worker was spawned for, and the call that spawned it (``apply_worker_env``).
INVOCATION_ENV = "FLOWPAD_INVOCATION_ID"
PARENT_CALL_ENV = "FLOWPAD_PARENT_CALL_ID"

#: Stamped "1" on every worker spawn by ``apply_worker_env`` (and inherited by a worker's own
#: children). It is the ONE signal that tells a worker apart from a human: the FlowPad desktop
#: terminal never calls ``apply_worker_env`` so it never carries this — unlike
#: ``FLOWPAD_EXECUTION_SCOPE``, which the desktop terminal sets too and so cannot distinguish them.
WORKER_ENV = "FLOWPAD_WORKER"


def is_worker_process() -> bool:
    """Whether this process is (or runs under) a FlowPad worker — see :data:`WORKER_ENV`."""
    return os.environ.get(WORKER_ENV) == "1"


def without_worker_signal(env: "dict[str, str] | None" = None) -> dict[str, str]:
    """A copy of *env* (or ``os.environ``) with the worker signal (:data:`WORKER_ENV`) removed.

    FLOWPAD-2112: use this to build the environment of any FlowPad *infrastructure* process — a
    backend, the monitor, a detached respawn, a browser. Such a process is never a worker, so it
    must not inherit ``FLOWPAD_WORKER`` (which only ``apply_worker_env`` sets). Were it to leak, a
    human in a terminal that infrastructure later spawns would be wrongly treated as a worker and
    blocked by the lifecycle gate. Every env-copying spawn path routes through here, so there is one
    place the signal is stripped rather than several that must each remember to.
    """
    base = dict(env) if env is not None else os.environ.copy()
    base.pop(WORKER_ENV, None)
    return base


def inherited_trace() -> dict:
    """The run this process's calls join: ``{"invocation_id", "parent_call_id"}``, or ``{}`` for none."""
    invocation_id = os.getenv(INVOCATION_ENV)
    if not invocation_id:
        return {}
    return {"invocation_id": invocation_id, "parent_call_id": os.getenv(PARENT_CALL_ENV) or None}
