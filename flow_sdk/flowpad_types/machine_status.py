"""Machine status types for process and network monitoring."""

from pydantic import BaseModel, Field

from flow_sdk.flowpad_types.runtime_environment import ExecutionEnvironmentStatus


class ProcessInfo(BaseModel):
    """Information about a running process."""

    pid: int = Field(description="Process ID")
    name: str = Field(description="Process name")
    cpu_percent: float = Field(description="CPU usage percentage")
    memory_mb: float = Field(description="Memory usage in MB")
    path: str = Field(default="", description="Executable path")
    status: str = Field(description="Process status (running, sleeping, etc)")


class NetworkConnection(BaseModel):
    """Information about a network connection/listening port."""

    port: int = Field(description="Port number")
    pid: int = Field(description="Process ID owning the port")
    process_name: str = Field(description="Name of the process")
    process_path: str = Field(default="", description="Path to the process executable")
    status: str = Field(description="Connection status (LISTEN, ESTABLISHED, etc)")
    type: str = Field(description="Connection type (TCP, UDP)")


class ComputeNodeInfo(BaseModel):
    """Configured compute node specifications."""

    size: str = Field(default="sm", description="Compute node size (sm, md, lg, or local)")
    cpu_count: int = Field(default=2, description="Number of CPU cores")
    memory_gb: float = Field(default=1.0, description="Configured memory in GB")
    os_type: str = Field(default="Linux", description="Operating system type")
    template_version: str | None = Field(default=None, description="E2B template version (e.g., v0-27-0)")


class MachineStatus(BaseModel):
    """Complete machine status including processes and network."""

    node_provider_status: ExecutionEnvironmentStatus = Field(
        default=ExecutionEnvironmentStatus.NEW, description="Provider status (READY, PAUSED, ERROR, NOT_FOUND)"
    )
    status_msg: str | None = Field(default=None, description="Status message (informational or error)")
    processes: list[ProcessInfo] = Field(default_factory=list, description="List of running processes")
    network: list[NetworkConnection] = Field(default_factory=list, description="List of network connections")
    cpu_percent: float = Field(default=0.0, description="Overall CPU usage percentage")
    memory_percent: float = Field(default=0.0, description="Overall memory usage percentage")
    memory_total_gb: float = Field(default=0.0, description="Total memory in GB")
    memory_available_gb: float = Field(default=0.0, description="Available memory in GB")
    node_info: ComputeNodeInfo | None = Field(default=None, description="Configured node specifications")


# Python script to be executed on the compute node to gather machine status
# This uses psutil for cross-platform compatibility
MACHINE_STATUS_SCRIPT = """
import json
import sys
import time

try:
    import psutil
except ImportError:
    print(json.dumps({"error": "psutil not installed. Run: pip install psutil"}))
    sys.exit(1)

def get_machine_status():
    result = {
        "processes": [],
        "network": [],
        "cpu_percent": 0.0,
        "memory_percent": 0.0,
        "memory_total_gb": 0.0,
        "memory_available_gb": 0.0
    }

    # Get overall CPU and memory
    result["cpu_percent"] = psutil.cpu_percent(interval=0.1)
    mem = psutil.virtual_memory()
    result["memory_percent"] = mem.percent
    result["memory_total_gb"] = round(mem.total / (1024**3), 2)
    result["memory_available_gb"] = round(mem.available / (1024**3), 2)

    # Get process information (top 50 by CPU)
    # NOTE: psutil.process_iter cpu_percent returns 0 on first call.
    # We need to call it twice with a small interval to get accurate values.
    procs = list(psutil.process_iter(["pid", "name", "memory_info", "exe", "status"]))

    # First pass: initialize CPU measurement for all processes
    for proc in procs:
        try:
            proc.cpu_percent()  # Initialize - returns 0, but starts measurement
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass

    # Wait a short interval for CPU measurement
    time.sleep(0.1)

    # Second pass: collect actual CPU values
    processes = []
    for proc in procs:
        try:
            cpu = proc.cpu_percent()  # Now returns actual value
            info = proc.info
            processes.append({
                "pid": info["pid"],
                "name": info["name"] or "unknown",
                "cpu_percent": cpu,
                "memory_mb": round((info["memory_info"].rss if info["memory_info"] else 0) / (1024**2), 2),
                "path": info["exe"] or "",
                "status": info["status"] or "unknown"
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass

    # Sort by CPU usage and take top 100
    processes.sort(key=lambda x: x["cpu_percent"], reverse=True)
    result["processes"] = processes[:100]

    # Get network connections (listening ports)
    # On macOS, psutil.net_connections() requires root, so we use per-process approach
    connections = []
    seen_ports = set()

    # Try system-wide first (works on Linux, requires root on macOS)
    use_fallback = False
    net_conns = []
    try:
        net_conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError, OSError):
        use_fallback = True

    if use_fallback:
        # Fallback: iterate through processes and get their connections
        # This works without elevated permissions on macOS
        for proc in procs:
            try:
                proc_conns = proc.connections(kind="inet")
                for conn in proc_conns:
                    if conn.laddr and conn.laddr.port:
                        port = conn.laddr.port
                        if port in seen_ports:
                            continue
                        if conn.status not in ("LISTEN", "ESTABLISHED", "TIME_WAIT"):
                            continue

                        seen_ports.add(port)
                        proc_name = ""
                        proc_path = ""
                        try:
                            proc_name = proc.name()
                            proc_path = proc.exe() or ""
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass

                        connections.append({
                            "port": port,
                            "pid": proc.pid,
                            "process_name": proc_name,
                            "process_path": proc_path,
                            "status": conn.status,
                            "type": "TCP" if conn.type == 1 else "UDP"
                        })
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
    else:
        # Use system-wide connections
        for conn in net_conns:
            try:
                if conn.laddr and conn.laddr.port:
                    port = conn.laddr.port
                    if port in seen_ports:
                        continue
                    if conn.status not in ("LISTEN", "ESTABLISHED", "TIME_WAIT"):
                        continue

                    seen_ports.add(port)
                    pid = conn.pid or 0
                    proc_name = ""
                    proc_path = ""

                    if pid:
                        try:
                            proc = psutil.Process(pid)
                            proc_name = proc.name()
                            proc_path = proc.exe() or ""
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass

                    connections.append({
                        "port": port,
                        "pid": pid,
                        "process_name": proc_name,
                        "process_path": proc_path,
                        "status": conn.status,
                        "type": "TCP" if conn.type == 1 else "UDP"
                    })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

    # Sort by port number
    connections.sort(key=lambda x: x["port"])
    result["network"] = connections

    # Ensure processes with network connections are included in the process list
    # (they may not be in top 50 by CPU if they have low usage)
    existing_pids = {p["pid"] for p in result["processes"]}
    network_pids = {c["pid"] for c in connections if c["pid"] and c["pid"] not in existing_pids}

    for pid in network_pids:
        try:
            proc = psutil.Process(pid)
            proc.cpu_percent()  # Initialize
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass

    if network_pids:
        time.sleep(0.1)  # Wait for CPU measurement

    for pid in network_pids:
        try:
            proc = psutil.Process(pid)
            cpu = proc.cpu_percent()
            mem_info = proc.memory_info()
            result["processes"].append({
                "pid": pid,
                "name": proc.name() or "unknown",
                "cpu_percent": cpu,
                "memory_mb": round(mem_info.rss / (1024**2), 2) if mem_info else 0,
                "path": proc.exe() or "",
                "status": proc.status() or "unknown"
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass

    return result

if __name__ == "__main__":
    status = get_machine_status()
    print(json.dumps(status))
"""
