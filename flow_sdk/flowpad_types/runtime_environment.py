"""Runtime environment types for compute nodes."""

import platform
from enum import Enum, StrEnum
from typing import Optional

from pydantic import BaseModel

try:
    import distro
except ImportError:
    distro = None


class RuntimeType(str, Enum):
    """Runtime type enumeration."""

    VM = "VM_RUNTIME"
    DOCKER = "DOCKER_RUNTIME"
    PROCESS = "PROCESS_RUNTIME"


class OSType(str, Enum):
    """Operating system type enumeration."""

    LINUX = "Linux"
    UBUNTU = "Ubuntu"
    DEBIAN = "DEBIAN"
    CENTOS = "CENTOS"
    ALPINE = "ALPINE"
    WINDOWS = "Windows"
    MACOS = "macOS"


class RuntimeStatus(str, Enum):
    """Runtime status enumeration."""

    NEW = "NEW"
    BOOT = "BOOT"
    STARTUP = "STARTUP"
    READY = "READY"


class OSInfo(BaseModel):
    """Operating system information."""

    os_type: str
    os_name: str
    version: str


def get_os_info() -> OSInfo:
    """Get current system OS information."""
    os_type = platform.system()

    name: Optional[str] = None
    version: Optional[str] = None

    if os_type == "Linux":
        if distro:
            name = distro.name()
            version = distro.version()
        else:
            try:
                with open("/etc/os-release") as f:
                    for line in f:
                        if line.startswith("PRETTY_NAME="):
                            name = line.strip().split("=")[1].strip('"')
                        elif line.startswith("VERSION_ID="):
                            version = line.strip().split("=")[1].strip('"')
            except FileNotFoundError:
                name = "Linux"
                version = platform.release()

    elif os_type == "Windows":
        name = "Windows"
        version = platform.version()

    elif os_type == "Darwin":
        name = "macOS"
        version = platform.mac_ver()[0]

    else:
        name = os_type
        version = platform.version()

    return OSInfo(os_type=os_type, os_name=name or "Unknown", version=version or "Unknown")


class RuntimeEnvironment(BaseModel):
    """Runtime environment configuration."""

    name: str = ""
    description: Optional[str] = None
    os_type: Optional[OSType] = None
    os_version: Optional[str] = None


class ComputeNodeSize(StrEnum):
    """Compute node size enumeration."""

    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"
    XLARGE = "xlarge"


class ExecutionEnvironmentStatus(StrEnum):
    """Execution environment status enumeration."""

    NEW = "NEW"
    READY = "READY"
    PAUSED = "PAUSED"
    ERROR = "ERROR"
    NOT_FOUND = "NOT_FOUND"
