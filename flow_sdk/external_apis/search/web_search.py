from __future__ import annotations

import asyncio
import logging
import time
import warnings
from dataclasses import dataclass
from typing import List, Literal, Optional, Union
from urllib.parse import quote, urlparse

import httpx
from pydantic import BaseModel, Field

from flow_sdk.config import default_service_config
from flow_sdk.external_apis.llm.simple_llm import llm_completion
from flow_sdk.utils.text import count_tokens, tiktoken_truncate, truncate_tokens

try:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    CRAWL4AI_AVAILABLE = True
except ImportError:
    CRAWL4AI_AVAILABLE = False
    AsyncWebCrawler = None
    BrowserConfig = None
    CacheMode = None
    CrawlerRunConfig = None

DEFAULT_SEARCH_NUM_RESULTS = 1
DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS = 5000


@dataclass
class SearchResult:
    """Represents a single search result with metadata."""

    term: str
    position: int
    google_item: dict

    @property
    def title(self) -> str:
        if not self.google_item:
            return ""
        """Get the title of the search result."""
        return self.google_item.get("title", "")

    @property
    def link(self) -> str:
        if not self.google_item:
            return ""
        """Get the title of the search result."""
        return self.google_item.get("link", "")

    @property
    def snippet(self) -> str:
        if not self.google_item:
            return ""
        """Get the snippet of the search result."""
        return self.google_item.get("snippet", "")

    @property
    def domain(self) -> str:
        if not self.link:
            return ""
        """Get the domain of the search result."""
        # Extract domain from the link
        parsed_url = urlparse(self.link)
        return parsed_url.netloc or parsed_url.path.split("/")[0]

    @property
    def is_subdomain(self) -> bool:
        """Check if the link is a subdomain."""
        if not self.link:
            return False
        parsed_url = urlparse(self.link)
        domain_parts = parsed_url.netloc.split(".")
        # ignore trivial cases like "localhost" or "www.example.com"
        if len(domain_parts) < 2:
            return False
        # A subdomain has more than 2 parts (e.g., "sub.example.com" has 3 parts)
        # A domain like "example.com" has 2 parts, so we check if there are more than 2
        # This will return True for subdomains like "sub.example.com" and False for "example.com"
        if len(domain_parts) == 2 and domain_parts[0] in ["www", "localhost"]:
            return False
        return len(domain_parts) > 2

    async def get_content(self) -> tuple[str, str]:
        """
        Asynchronously fetch the content of the result using Crawl4AI's fast crawler.
        Returns a tuple: (link, markdown_content)
        """
        start_time = time.time()

        if not self.link:
            return self.link, ""

        if not CRAWL4AI_AVAILABLE:
            return self.link, f"_crawl4ai not installed - snippet: {self.snippet}_"

        # Configure for ultra-fast single-page crawling
        config = BrowserConfig(headless=True, text_mode=True, light_mode=True, verbose=False, java_script_enabled=False)
        run_config = CrawlerRunConfig(
            cache_mode=CacheMode.ENABLED,
            only_text=True,  # Extract only text for speed
            exclude_external_links=True,
            exclude_internal_links=True,
            exclude_social_media_links=True,
            excluded_tags=["a", "form", "header"],
            remove_overlay_elements=True,  # Remove popups/overlays
            page_timeout=3000,  # 3 second page load timeout
            delay_before_return_html=0,  # No delay
            process_iframes=False,
        )

        try:
            # Add timeout to the entire crawl operation
            async with AsyncWebCrawler(config=config) as crawler:
                result = await asyncio.wait_for(
                    crawler.arun(self.link, config=run_config),
                    timeout=4.0,  # 4 second max per individual crawl
                )

                crawl_time = time.time() - start_time
                logging.debug("Crawled %s in %.2f seconds", self.link, crawl_time)

                # Extract content from the crawl result
                try:
                    content = (
                        getattr(result, "markdown", None)
                        or getattr(result, "cleaned_html", None)
                        or getattr(result, "text", None)
                        or "_No content extracted_"
                    )
                    content_str = content.strip() if isinstance(content, str) else str(content)

                    return self.link, content_str

                except AttributeError:
                    return self.link, "_Content extraction failed_"

        except asyncio.TimeoutError:
            crawl_time = time.time() - start_time
            logging.warning(f"Timeout crawling {self.link} after {crawl_time:.2f}s")
            return self.link, "_Crawl timed out_"

        except Exception as e:
            crawl_time = time.time() - start_time
            logging.warning(f"Failed to crawl {self.link} in {crawl_time:.2f}s: {e}")
            return self.link, f"_Failed to fetch content: {e}_"

    def __str__(self):
        return f"SearchResult(link={self.link}, term={self.term}, position={self.position}, title={self.title})"

    def __repr__(self):
        return (
            f"SearchResult(link={self.link},title={self.title}, term={self.term}, position={self.position}, "
            f"snippet={self.snippet}, domain={self.domain})"
        )


async def crawl_all_results(results: List[SearchResult]) -> dict[str, str]:
    """
    Crawl content for all results in parallel using the fast crawler.
    Returns a dictionary mapping link -> crawled markdown content.
    """
    start_time = time.time()

    logging.debug(f"🚀 Starting parallel crawl of {len(results)} URLs")

    # Create tasks with individual timing
    tasks = [result.get_content() for result in results]

    # Execute all crawls in parallel with timeout
    try:
        results_content = await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=10.0,  # 10 second total timeout for all crawls
        )

        total_time = time.time() - start_time
        logging.debug(f"✅ Crawling completed in {total_time:.2f}s")

        # Process results and log any errors
        crawled_data = {}
        for i, result in enumerate(results_content):
            if isinstance(result, Exception):
                logging.warning(f"❌ Failed to crawl {results[i].link}: {result}")
                crawled_data[results[i].link] = f"_Crawl failed: {result}_"
            elif isinstance(result, tuple) and len(result) == 2:
                link, content = result  # Unpack tuple only if it's a valid tuple
                crawled_data[link] = content
                logging.debug(f"📄 Successfully crawled {link[:50]}... ({len(content)} chars)")
            else:
                logging.warning(f"❌ Unexpected result type for {results[i].link}: {type(result)}")
                crawled_data[results[i].link] = "_Unexpected result format_"

        return crawled_data

    except asyncio.TimeoutError:
        logging.error("🚨 Crawling timed out after 10 seconds")
        return {result.link: "_Crawl timed out_" for result in results}


def format_results_with_crawled_content(results: List[SearchResult], crawled_content: dict[str, str]) -> str:
    """
    Format the search results along with their crawled content as Markdown.
    """
    markdown_output = "# Search Results with Content\n\n"

    for result in results:
        markdown_output += f"## [{result.title}]({result.link})\n"
        markdown_output += f"**Domain**: `{result.domain}`  \n"
        markdown_output += f"{result.snippet}\n\n"

        content = crawled_content.get(result.link, "_No content available._")
        markdown_output += f"### Crawled Content\n{content}\n"
        markdown_output += "---\n"

    return markdown_output.strip()


class SearchInformation(BaseModel):
    """Information about the search results."""

    totalResults: str = Field(description="Total number of results found")
    queries: List[str] = Field(description="Search queries used")
    filtered: Optional[bool] = Field(default=None, description="Whether results were filtered by LLM")


class SearchResponse(BaseModel):
    """Response model for search operations."""

    items: List[SearchResult] = Field(description="List of search results")
    searchInformation: SearchInformation = Field(description="Metadata about the search")
    filtered_items: Optional[List[SearchResult]] = Field(default=None, description="Filtered search results if any")
    model_config = {"arbitrary_types_allowed": True}

    @property
    def scan_limit(self):
        if not self.items:
            return 0
        """Get the number of search results."""
        return len(self.items)


# Use the centralized service configuration instead of environment variables


def get_search_url(url: str, params: dict) -> str:
    """
    Construct a search URL with query parameters.

    Args:
        url: Base URL for the search API
        params: Dictionary of query parameters

    Returns:
        Complete URL with query parameters
    """
    if not url:
        raise Exception("Google search URL is not set in the environment")

    # Build query string from params
    query_parts = []
    for key, value in params.items():
        if value is not None:
            query_parts.append(f"{key}={quote(str(value))}")

    if query_parts:
        return f"{url}?{'&'.join(query_parts)}"
    return url


async def smart_search(
    query: Union[str, list[str]],
    site_search: str | None = None,
    site_search_filter: Literal["i", "e"] | None = None,
    scan_limit: int | None = None,
    client: Optional[httpx.AsyncClient] = None,
    filter_prompt: Optional[str] = None,
    num_results: int = DEFAULT_SEARCH_NUM_RESULTS,
    **search_params,
) -> SearchResponse:
    """
    See possible search parameters at:
    https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list

    Args:
        query: Single query string or list of query strings
        site_search: Optional site to search within
        site_search_filter: Optional site search filter
        scan_limit: pool of results to scan, from which we take num_results
        client: Optional httpx client
        filter_prompt: Optional prompt to filter results using LLM
        num_results: number of results to return after filtering
        **search_params: Additional search parameters
    """
    url = default_service_config.google_search_url
    if not url:
        raise Exception("Google search URL is not set in the environment")

    # Handle single query vs list of queries
    if isinstance(query, str):
        queries = [query]
    else:
        queries = query

    all_items = []
    total_results = 0
    query_results = []  # Store results from each query separately

    # First, collect results from all queries
    for single_query in queries:
        params = {
            "key": default_service_config.google_search_key,
            "cx": default_service_config.google_search_context,
            "q": single_query,
            **search_params,
        }

        if site_search:
            params["siteSearch"] = site_search

        if site_search_filter:
            params["siteSearchFilter"] = site_search_filter

        # Use the new get_search_url function
        search_url = get_search_url(url, params)

        if client is not None:
            result = await client.get(search_url)
            response_data = result.json()
        else:
            async with httpx.AsyncClient() as temp_client:
                result = await temp_client.get(search_url)
                response_data = result.json()

        # Store results from this query
        # noinspection PyUnboundLocalVariable
        query_items = response_data.get("items", [])
        query_results.append(query_items)

        # Update total results count
        if "searchInformation" in response_data:
            total_results += int(response_data["searchInformation"].get("totalResults", 0))

    # Now interleave results by position and create SearchResult objects
    # Pop one item from each query result in round-robin fashion
    position = 1  # Start with position 1 (first batch)
    query_indices = list(range(len(query_results)))  # Track which queries still have results

    while query_indices and len(all_items) < (scan_limit or float("inf")):
        # Create a copy of indices to iterate over, as we'll modify the list
        current_indices = query_indices.copy()

        for query_idx in current_indices:
            if len(all_items) >= (scan_limit or float("inf")):
                break

            query_items = query_results[query_idx]
            if query_items:  # If this query still has results
                # Pop the first item from this query
                google_item = query_items.pop(0)
                search_result = SearchResult(
                    term=queries[query_idx],
                    position=position,  # Position represents the batch order
                    google_item=google_item,
                )
                # add only if link does not already exist
                if not any(item.link == search_result.link for item in all_items):
                    # Append the search result to the all_items list
                    all_items.append(search_result)
            else:
                # This query has no more results, remove it from indices
                query_indices.remove(query_idx)

        position += 1  # Move to next batch

    # Apply filter if filter_prompt is provided
    if filter_prompt and filter_prompt != "" and all_items:
        best_results = await llm_search_filter(all_items, filter_prompt, num_results)
        if best_results:
            # Return filtered results
            search_info = SearchInformation(totalResults=str(len(best_results)), queries=queries, filtered=True)
            removed_items = [item for item in all_items if item not in best_results]
            return SearchResponse(items=best_results, searchInformation=search_info, filtered_items=removed_items)
        else:
            # No results matched the filter
            search_info = SearchInformation(totalResults="0", queries=queries, filtered=True)
            return SearchResponse(items=[], searchInformation=search_info, filtered_items=all_items)
    else:
        # Return all results without filtering
        search_info = SearchInformation(totalResults=str(total_results), queries=queries)
        return SearchResponse(items=all_items, searchInformation=search_info)


async def llm_search_filter(
    results: List[SearchResult], filter_prompt: str, num_results: int = DEFAULT_SEARCH_NUM_RESULTS
) -> List[SearchResult]:
    """
    Filter search results using LLM to find the best matching results based on the filter prompt.

    Args:
        results: List of SearchResult objects to filter
        filter_prompt: The filtering criteria to apply
        num_results: number of results that will be returned

    Returns:
        List of best matching SearchResults based on the filter prompt (up to num_results)
    """
    logging.debug(f"Filtering {len(results)} search results using LLM")

    # Get configuration from ServiceConfig
    model = default_service_config.search_model

    # Generate search context string with all search results details
    search_context = "Search Results:\n\n"
    for i, result in enumerate(results):
        search_context += f"Result {i + 1}:\n"
        search_context += f"  Title: {result.title}\n"
        search_context += f"  Link: {result.link}\n"
        search_context += f"  Domain: {result.domain}\n"
        search_context += f"  Snippet: {result.snippet}\n"
        search_context += f"  Search Term: {result.term}\n\n"

    # Generate instruction with the filter prompt embedded
    instruction = f"""You are a search result filter for development queries. Your task is to analyze the provided search results and select the TOP {num_results} best matching results based on the following filter criteria:

{filter_prompt}

Return ONLY the complete link URLs of the best matching results, one per line, in order of relevance (best first).
Return up to {num_results} URLs.
If no results match the criteria, return "not_found".
Do not include any explanation or additional text."""

    # Run through LLM to get the best matching results
    logging.debug(f"Using model {model} to filter search results")
    best_links_response = await llm_completion(instruction, search_context, stream=False, model=model)

    # Parse the response to get individual links
    best_links = []
    for line in best_links_response.strip().split("\n"):
        link = line.strip().rstrip("/")
        if link and link != "not_found":
            best_links.append(link)

    logging.debug(f"LLM returned {len(best_links)} filtered links")

    # Find and return the SearchResults with the matching links
    filtered_results = []
    for best_link in best_links:
        # Try exact match first
        for result in results:
            if result.link.strip().rstrip("/") == best_link:
                if result not in filtered_results:  # Avoid duplicates
                    filtered_results.append(result)
                break
        else:
            # Try partial matches
            for result in results:
                if best_link in result.link.strip().rstrip("/") or result.link.strip().rstrip("/") in best_link:
                    if result not in filtered_results:  # Avoid duplicates
                        filtered_results.append(result)
                    break

    logging.debug(f"Successfully matched {len(filtered_results)} search results")

    # If no matches found, and we have results, return the top few original results as fallback
    if not filtered_results and results:
        logging.warning("No LLM matches found, returning top original results as fallback")
        return results[:num_results]

    return filtered_results[:num_results]


async def web_search_results_compress(
    markdown_report: str,
    filter_prompt: str,
    max_output_tokens: int = DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS,
) -> str | None:
    """
    Compress search results using LLM while respecting token limits.

    Args:
        markdown_report: The markdown report to compress
        filter_prompt: The user's original query for context
        max_output_tokens: Maximum number of output tokens allowed for the compressed report

    Returns:
        Compressed markdown report or truncated report if compression fails
    """
    # Get configuration
    max_input_tokens = default_service_config.search_results_compression_model_max_input_token
    compression_model = default_service_config.search_compression_model
    logging.info(f"🗜️ Compressing with user max_output_tokens={max_output_tokens}")
    try:
        # Check input token count
        input_tokens = await count_tokens(markdown_report)
        logging.debug(f"Input markdown report has {input_tokens} tokens")

        if input_tokens > max_input_tokens:
            # Smart truncation to fit within model's input limit
            logging.warning(
                f"Markdown report has {input_tokens} tokens, truncating to fit {max_input_tokens} token limit"
            )
            markdown_report = truncate_tokens(markdown_report, max_input_tokens)

            # Verify truncation worked
            final_tokens = await count_tokens(markdown_report)
            if final_tokens > max_input_tokens:
                logging.error(f"Truncation failed to meet limit: {final_tokens} > {max_input_tokens} tokens")
                # Try one more time with tiktoken direct truncation
                markdown_report = tiktoken_truncate(markdown_report, max_input_tokens)
                final_tokens = await count_tokens(markdown_report)
                if final_tokens > max_input_tokens:
                    logging.error(f"All truncation methods failed, returning best effort ({final_tokens} tokens)")
                return markdown_report

        instruction = f"""You are a search results compressor for development queries. 
        Your task is to analyze the provided search results and compress the content to fit within the maximum token limit {max_output_tokens}:
        This is the user's query:
        {filter_prompt}
        The compress results should give the most relevant information to answer the user's query from the search results.
        Do not include any explanation or additional text."""

        # Run through LLM to get the best matching results
        logging.debug(f"Using model {compression_model} to compress search results")
        compressed_results = await llm_completion(instruction, markdown_report, stream=False, model=compression_model)

        # Verify the compressed results fit within output token limit
        if compressed_results:
            output_tokens = await count_tokens(compressed_results)
            logging.debug(f"Compressed results have {output_tokens} tokens")

            if output_tokens > max_output_tokens:
                logging.warning(
                    f"Compressed results ({output_tokens} tokens) exceed limit ({max_output_tokens}), truncating"
                )
                compressed_results = truncate_tokens(compressed_results, max_output_tokens)

                # Final verification
                final_output_tokens = await count_tokens(compressed_results)
                logging.info(f"Final compressed output: {final_output_tokens} tokens")

        return compressed_results

    except Exception as e:
        logging.error(f"Error during compression: {e}")
        # Fallback: return smartly truncated original content
        logging.info("Falling back to truncated original content")
        try:
            return truncate_tokens(markdown_report, max_output_tokens)
        except Exception as fallback_error:
            logging.error(f"Fallback truncation also failed: {fallback_error}")
            # Ultimate fallback: return empty string or minimal content
            return "_Compression and truncation failed. Content unavailable._"


# Backward compatibility wrapper
async def web_search(
    query: Union[str, list[str]],
    filter_prompt: str,
    site_search: str | None = None,
    site_search_filter: Literal["i", "e"] | None = None,
    scan_limit: int | None = None,
    num_results: int = DEFAULT_SEARCH_NUM_RESULTS,
    max_output_tokens: int = DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS,
    **search_params,
) -> str:
    """
    See possible search parameters at:
    https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list

    Args:
        query: Single query string or list of query strings
        filter_prompt: prompt to filter results using LLM
        site_search: Optional site to search within
        site_search_filter: Optional site search filter
        scan_limit: pool of results to scan, from which we take num_results
        num_results: number of results to return after filtering
        max_output_tokens: Maximum number of output tokens for the final report
        **search_params: Additional search parameters
    """
    import time

    start_time = time.time()

    logging.info("🔍 Starting web_search")
    logging.info(f"🔧 Web search parameters: query='{query}', num_results={num_results}, scan_limit={scan_limit}")

    # Phase 1: Smart search (Google API + LLM filtering)
    search_start = time.time()
    response = await smart_search(
        query=query,
        site_search=site_search,
        site_search_filter=site_search_filter,
        scan_limit=scan_limit,
        client=None,  # Use default client
        filter_prompt=filter_prompt,
        num_results=num_results,
        **search_params,
    )
    search_time = time.time() - search_start

    # Phase 2: Parallel crawling
    crawl_start = time.time()
    crawled_content = await crawl_all_results(response.items)
    crawl_time = time.time() - crawl_start

    # Phase 3: Format results
    format_start = time.time()
    markdown_report = format_results_with_crawled_content(response.items, crawled_content)
    format_time = time.time() - format_start

    # Phase 4: Compress the results if too long
    compression_start = time.time()
    report_tokens = await count_tokens(markdown_report)

    if report_tokens > max_output_tokens:
        logging.warning(
            f"Markdown report has {report_tokens} tokens, exceeds user limit of {max_output_tokens}, compressing..."
        )
        compressed_report = await web_search_results_compress(
            markdown_report, filter_prompt=filter_prompt, max_output_tokens=max_output_tokens
        )
        if compressed_report:
            markdown_report = compressed_report
            final_tokens = await count_tokens(markdown_report)
            logging.info(f"Compression reduced tokens from {report_tokens} to {final_tokens}")
        else:
            logging.error("Compression failed, using original report")

    compression_time = time.time() - compression_start

    total_time = time.time() - start_time
    logging.info(
        f"✅ web_search completed in {total_time:.2f}s (search: {search_time:.2f}s, crawl: {crawl_time:.2f}s, format: {format_time:.2f}s, compression: {compression_time:.2f}s)"
    )

    # Open this when you want to see what was passed to the LLM
    # logging.debug("*******************************************")
    # logging.debug(markdown_report)
    # logging.debug("*******************************************")

    return markdown_report
