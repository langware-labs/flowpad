"""Search tool handler and tool creation functions."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal, Union

from pydantic_ai import Tool
from pydantic_ai.messages import ToolReturnPart

from flow_sdk.core.flow.streaming.response_handler import CallbackHandler
from flow_sdk.external_apis.search.fetch_web_content import WEB_FETCH_MAX_SIZE, WEB_FETCH_TIMEOUT, fetch_web_content
from flow_sdk.external_apis.search.web_search import (
    DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS,
    DEFAULT_SEARCH_NUM_RESULTS,
    web_search,
)

from .base import FlowToolHandler
from .models import SearchConfig, SearchMode, ToolCallInvocationPart

if TYPE_CHECKING:
    pass


class SearchToolHandler(FlowToolHandler):
    _callback_handler: CallbackHandler

    def __init__(self, callback_handler: CallbackHandler, **kwargs):
        super().__init__(**kwargs)
        self._callback_handler = callback_handler

    @property
    def callback_handler(self) -> CallbackHandler:
        return self._callback_handler

    async def on_tool_call_invocation(self, part: ToolCallInvocationPart):
        await self._callback_handler.on_status("Searching the web...")

    async def on_tool_result(self, result: ToolReturnPart):
        await self._callback_handler.on_status("Thinking...")


def create_search_tool(search_config: SearchConfig | None = None) -> Tool:
    """Create a search tool for agents based on their search configuration."""

    # Get search settings from agent's config
    search_mode = SearchMode.FAST  # default
    num_results = DEFAULT_SEARCH_NUM_RESULTS  # default
    max_output_tokens = DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS  # default
    if search_config:
        search_mode = search_config.search_mode
        num_results = search_config.num_results
        max_output_tokens = search_config.max_output_tokens

    logging.info(
        f"🔧 Search tool configuration: mode={search_mode.value}, num_results={num_results}, max_output_tokens={max_output_tokens}"
    )

    # Create a wrapper function that includes the agent's configuration
    async def agent_web_search(
        query: Union[str, list[str]],
        filter_prompt: str,
        site_search: str | None = None,
        site_search_filter: Literal["i", "e"] | None = None,
        scan_limit: int | None = None,
        **search_params,
    ) -> str:
        # Print the search parameters chosen by the LLM

        return await web_search(
            query=query,
            filter_prompt=filter_prompt,
            site_search=site_search,
            site_search_filter=site_search_filter,
            scan_limit=scan_limit,
            num_results=num_results,
            max_output_tokens=max_output_tokens,
            **search_params,
        )

    return Tool(
        function=agent_web_search,
        name="web_search",
        description=(
            f"Search the internet for information and crawl relevant web pages to get their content. "
            f"This tool is configured to return {num_results} result(s) based on user preferences. "
            f"Useful for finding current information about companies, people, technologies, or any topic "
            f"that requires up-to-date web content. The tool automatically filters for relevant links and returns crawled content."
        ),
    )


def create_web_fetch_tool(search_config: SearchConfig | None = None) -> Tool:
    """Create a tool that fetches and extracts content from web pages based on search configuration."""

    # Get search settings from agent's config
    search_mode = SearchMode.FAST  # default
    max_output_tokens = DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS  # default
    if search_config:
        search_mode = search_config.search_mode
        max_output_tokens = search_config.max_output_tokens

    if search_mode == SearchMode.FAST:
        mode_guidance = "For Fast Search: Use fetch_mode='html' and enable_javascript=False for speed."
    else:
        mode_guidance = "For Deep Search: Use fetch_mode='markdown' and enable_javascript=True when needed for comprehensive content."

    logging.info(
        f"🔧 Web fetch tool configuration: search_mode={search_mode.value}, max_output_tokens={max_output_tokens}, guidance='{mode_guidance}'"
    )

    # Create a wrapper function to print the parameters chosen by the LLM
    async def agent_web_fetch(
        url: str,
        fetch_mode: Literal["html", "markdown"] = "html",
        enable_javascript: bool = False,
        **fetch_params,
    ) -> str:
        # Print the fetch parameters chosen by the LLM
        logging.info("🌐 LLM chose FETCH parameters:")
        logging.info(f"   📋 Search Mode: {search_mode.value}")
        logging.info(f"   🎛️ Max Output Tokens: {max_output_tokens} (from user settings)")
        logging.info(f"   🔗 URL: {url}")
        logging.info(f"   📄 Fetch Mode: {fetch_mode}")
        logging.info(f"   🚀 Enable JavaScript: {enable_javascript}")
        if fetch_params:
            logging.info(f"   ⚙️  Extra Params: {fetch_params}")

        return await fetch_web_content(
            url=url,
            fetch_mode=fetch_mode,  # type: ignore[arg-type]
            enable_javascript=enable_javascript,
            max_output_tokens=max_output_tokens,
            **fetch_params,
        )

    return Tool(
        function=agent_web_fetch,
        name="fetch_web_content",
        description=(
            f"Fetch and extract readable content from any web page given a URL. "
            f"Priority: 1) Checks for /llms.txt first, 2) Uses specified fetch_mode. "
            f"Parameters: url (required), fetch_mode ('html' for BeautifulSoup parsing, 'markdown' for crawl4ai extraction), "
            f"enable_javascript (bool, default False - set True for dynamic content that needs JavaScript). "
            f"{mode_guidance} "
            f"Choose 'html' for structured content with titles/descriptions, 'markdown' for clean text extraction. "
            f"Enable JavaScript when initial fetch doesn't retrieve enough data - slower but gets dynamic content via Playwright. "
            f"Useful for reading articles, documentation, blog posts, or any web content. "
            f"Configured with {WEB_FETCH_TIMEOUT}s timeout and {WEB_FETCH_MAX_SIZE // 1024 // 1024}MB size limit."
        ),
    )
