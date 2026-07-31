"""Provider drivers — the only modules allowed to know a provider's shape.

Importing this package registers every shipped driver. Nothing outside
``drivers/`` may read a provider-private key out of a cursor's ``state``;
``test_cursor_state_is_opaque_to_the_subsystem`` enforces that by grep.
"""
from flow_sdk.ingest.driver import register_driver
from flow_sdk.ingest.drivers.agent import AgentDriver
from flow_sdk.ingest.drivers.hackernews import HackerNewsDriver
from flow_sdk.ingest.drivers.rss import RssDriver

register_driver(RssDriver())
register_driver(HackerNewsDriver())
register_driver(AgentDriver())

__all__ = ["AgentDriver", "HackerNewsDriver", "RssDriver"]
