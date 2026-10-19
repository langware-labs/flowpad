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


def inherited_trace() -> dict:
    """The run this process's calls join: ``{"invocation_id", "parent_call_id"}``, or ``{}`` for none."""
    invocation_id = os.getenv(INVOCATION_ENV)
    if not invocation_id:
        return {}
    return {"invocation_id": invocation_id, "parent_call_id": os.getenv(PARENT_CALL_ENV) or None}
