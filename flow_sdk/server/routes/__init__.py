"""Route modules for the flow_sdk server."""

from .agent_records import router as agent_records_router
from .asset_share import router as asset_share_router
from .assets import router as assets_router
from .auth import router as auth_router
from .bootstrap import router as bootstrap_router
from .capabilities import router as capabilities_router
from .chat import router as chat_router
from .cloud import router as cloud_router
from .debug import router as debug_router
from .dep_graph import router as dep_graph_router
from .detection import router as detection_router
from .directory import router as directory_router
from .display import router as display_router
from .activity import router as activity_router
from .docs_graph import router as docs_graph_router
from .favorites import router as favorites_router
from .git import router as git_router
from .graph import graph_router
from .graph_workflows import router as graph_workflows_router
from .health import health_router
from .hooks import router as hooks_router
from .ingest import router as ingest_router
from .journeys import router as journeys_router
from .markdown_index import router as markdown_index_router
from .navigate import router as navigate_router
from .privacy import router as privacy_router
from .project import router as project_router
from .pty_stream import router as pty_stream_router
from .rules import router as rules_router
from .runs import router as runs_router
from .search import router as search_router
from .semantic_checker import router as semantic_checker_router
from .subgraph import router as subgraph_router
from .tags import router as tags_router
from .testing import router as testing_router
from .toplog import router as toplog_router
from .transcripts import router as transcripts_router
from .ui import router as ui_router
from .version import router as version_router
from .watch import router as watch_router
from .webhook import webhook_router as webhook_api_router
from .websocket import websocket_router
from .wiki import router as wiki_router
from .worldview import router as worldview_router

__all__ = [
    "bootstrap_router",
    "graph_router",
    "health_router",
    "auth_router",
    "cloud_router",
    "privacy_router",
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
    "debug_router",
    "ingest_router",
    "runs_router",
    "subgraph_router",
    "tags_router",
    "asset_share_router",
    "display_router",
    "navigate_router",
    "agent_records_router",
    "transcripts_router",
    "wiki_router",
    "dep_graph_router",
    "version_router",
    "favorites_router",
    "markdown_index_router",
    "activity_router",
    "docs_graph_router",
    "semantic_checker_router",
    "pty_stream_router",
    "capabilities_router",
    "toplog_router",
    "graph_workflows_router",
    "journeys_router",
    "git_router",
    "worldview_router",
]
