"""Route modules for the flow_sdk server."""

from .bootstrap import router as bootstrap_router
from .graph import graph_router
from .health import health_router
from .auth import router as auth_router
from .cloud import router as cloud_router
from .hooks import router as hooks_router
from .chat import router as chat_router
from .directory import router as directory_router
from .detection import router as detection_router
from .search import router as search_router
from .testing import router as testing_router
from .ui import router as ui_router
from .websocket import websocket_router
from .webhook import webhook_router as webhook_api_router
from .rules import router as rules_router
from .watch import router as watch_router
from .assets import router as assets_router
from .project import router as project_router
from .compute_register import compute_register_router
from .debug import router as debug_router
from .navigate import router as navigate_router
from .agent_records import router as agent_records_router
from .transcripts import router as transcripts_router
from .wiki import router as wiki_router
from .dep_graph import router as dep_graph_router
from .version import router as version_router
from .favorites import router as favorites_router

__all__ = [
    "bootstrap_router",
    "graph_router",
    "health_router",
    "auth_router",
    "cloud_router",
    "hooks_router",
    "chat_router",
    "directory_router",
    "detection_router",
    "search_router",
    "testing_router",
    "ui_router",
    "websocket_router",
    "webhook_api_router",
    "rules_router",
    "watch_router",
    "assets_router",
    "project_router",
    "compute_register_router",
    "debug_router",
    "navigate_router",
    "agent_records_router",
    "transcripts_router",
    "wiki_router",
    "dep_graph_router",
    "version_router",
    "favorites_router",
]
