import asyncio
import logging
import warnings
from typing import Dict, List, Optional, Set, Tuple, cast
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

import httpx
from markdown_it_pyrs import MarkdownIt, Node
from tld import Result as TLDResult
from tld import get_tld

from flow_sdk.knowledge_engine.crawler.crawl_utils import CrawlerError
from flow_sdk.utils import global_httpx_async_client

try:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from crawl4ai import (
            AsyncWebCrawler,
            BFSDeepCrawlStrategy,
            CrawlerRunConfig,
            CrawlResult,
            DefaultMarkdownGenerator,
            DomainFilter,
            FilterChain,
            LXMLWebScrapingStrategy,
            PruningContentFilter,
            RateLimiter,
            SemaphoreDispatcher,
        )
    CRAWL4AI_AVAILABLE = True
except ImportError:
    CRAWL4AI_AVAILABLE = False
    AsyncWebCrawler = None
    BFSDeepCrawlStrategy = None
    CrawlerRunConfig = None
    CrawlResult = None
    DefaultMarkdownGenerator = None
    DomainFilter = None
    FilterChain = None
    LXMLWebScrapingStrategy = None
    PruningContentFilter = None
    RateLimiter = None
    SemaphoreDispatcher = None


if CRAWL4AI_AVAILABLE:
    class DocsDomainFilter(DomainFilter):
        """
        A filter that blocks all URLs that contain "docs" in the domain, and keeps track of the docs urls requested.
        """

        def __init__(self, root_url: str):
            self._docs_urls: list[str] = []
            self._root_docs_url: str = ""
            result = get_tld(root_url, as_object=True, fail_silently=True)
            if not isinstance(result, TLDResult):
                super().__init__()
                return
            self._root_docs_url = f"https://docs.{result.domain}.{result.tld}/"
            super().__init__(blocked_domains=[self._root_docs_url])

        def apply(self, url: str) -> bool:
            url_filtered = super().apply(url)
            if not url_filtered:
                self._docs_urls.append(url)
            return url_filtered
else:
    DocsDomainFilter = None


async def deep_crawl_default(
    urls: list[str], max_depth: int, max_urls: int, blocked_domains: list[str] = []
) -> list[tuple[str, str | CrawlerError]]:
    if not CRAWL4AI_AVAILABLE:
        return [(url, CrawlerError("crawl4ai not available")) for url in urls]
    # TODO: Use await crawler.arun_many with Semaphore, once https://github.com/unclecode/crawl4ai/issues/855 is fixed
    # Currently we use asyncio.gather without semaphore, which might lead to high (memory?) usage
    results = await asyncio.gather(*(_deep_crawl_single(url, max_depth, max_urls, blocked_domains) for url in urls))
    results = [item for sublist in results for item in sublist]
    return results


async def _deep_crawl_single(
    url: str, max_depth: int, max_urls: int, blocked_domains: list[str] = [], special_docs_crawling: bool = True
) -> list[tuple[str, str | CrawlerError]]:
    prune_filter = PruningContentFilter(
        # Lower → more content retained, higher → more content pruned
        threshold_type="dynamic",
    )
    md_generator = DefaultMarkdownGenerator(content_filter=prune_filter)
    docs_filter = DocsDomainFilter(url) if special_docs_crawling else None
    deep_crawl_strategy = FlowDeepCrawlStrategy(
        max_depth=max_depth,
        max_pages=max_urls,
        filter_chain=FilterChain(
            [DomainFilter(blocked_domains), docs_filter] if docs_filter else [DomainFilter(blocked_domains)]
        ),
    )

    async with AsyncWebCrawler() as crawler:
        crawler_run_config = CrawlerRunConfig(
            deep_crawl_strategy=deep_crawl_strategy,
            scraping_strategy=LXMLWebScrapingStrategy(),
            markdown_generator=md_generator,
            semaphore_count=1,
            page_timeout=30000,
            verbose=True,
            # check_robots_txt=True,
        )
        # It fails. https://github.com/unclecode/crawl4ai/issues/855
        # results = await crawler.arun_many(
        #     urls,
        #     config=crawler_run_config,
        #     dispatcher=SemaphoreDispatcher(semaphore_count=20),
        #     # MemoryAdaptiveDispatcher has a bug https://github.com/unclecode/crawl4ai/issues/794
        # )
        # Until https://github.com/unclecode/crawl4ai/issues/855 is fixed, use crawler.arun.
        with warnings.catch_warnings():
            # TODO Remove when https://github.com/unclecode/crawl4ai/pull/1077 is merged
            warnings.simplefilter("ignore", DeprecationWarning)
            results = await crawler.arun(url, config=crawler_run_config)
        if not isinstance(results, list):
            raise CrawlerError(f"Failed to crawl {url}")
    deduped_results = list(({normalize_url_for_deep_crawl(result.url, url): result for result in results}).values())
    if len(deduped_results) != len(results):
        logging.warning(f"Deduped {len(results) - len(deduped_results)} results from {url}")
    deep_crawl_results = [
        (
            cast(str, result.url),
            cast(str, result._markdown.fit_markdown) if result.success else CrawlerError(result.error_message),
        )
        for result in deduped_results
    ]
    if docs_filter and docs_filter._docs_urls and docs_filter._root_docs_url:
        logging.info(f"Docs URLs requested: {docs_filter._root_docs_url}")
        # Running llms.txt crawler on the docs urls.
        deep_crawl_results += await crawl_llm_txt(
            [docs_filter._root_docs_url + LLM_TXT_URL],
            max_depth - 1,
            max_urls - len(deep_crawl_results),
            blocked_domains,
        )
    return deep_crawl_results


async def crawl_default(urls: list[str]) -> list[tuple[str, str | CrawlerError]]:
    if not CRAWL4AI_AVAILABLE:
        return [(url, CrawlerError("crawl4ai not available")) for url in urls]
    async with AsyncWebCrawler() as crawler:
        crawler_run_config = CrawlerRunConfig(
            semaphore_count=1,
            page_timeout=30000,
            verbose=True,
        )
        results = await crawler.arun_many(
            urls,
            config=crawler_run_config,
            dispatcher=SemaphoreDispatcher(semaphore_count=1),
        )
        if not isinstance(results, list):
            raise CrawlerError(f"Failed to crawl {urls}")
    return [
        (result.url, cast(str, result.markdown) if result.success else CrawlerError(result.error_message))
        for result in results
    ]


def normalize_url_for_deep_crawl(href: str | None, base_url: str):
    """Normalize URLs to ensure consistent format, ignoring http vs https"""

    # Handle None or empty values
    if not href:
        return None

    # Use urljoin to handle relative URLs
    full_url = urljoin(base_url, href.strip())

    # Parse the URL for normalization
    parsed = urlparse(full_url)

    # Convert hostname to lowercase
    netloc = parsed.netloc.lower()

    # Remove fragment entirely
    fragment = ""

    # Normalize query parameters if needed
    query = parsed.query
    if query:
        # Parse query parameters
        params = parse_qs(query)

        # Remove tracking parameters (example - customize as needed)
        tracking_params = [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "ref",
            "fbclid",
        ]
        for param in tracking_params:
            if param in params:
                del params[param]

        # Rebuild query string, sorted for consistency
        query = urlencode(params, doseq=True) if params else ""

    # Build normalized URL, forcing http for consistency
    normalized = urlunparse(
        (
            "https",  # Force https
            netloc,
            parsed.path.rstrip("/") or "/",  # Normalize trailing slash
            parsed.params,
            query,
            fragment,
        )
    )

    return normalized


LLM_TXT_URL = "llms.txt"

md = MarkdownIt("gfm")


def _extract_links(node: Node, links: list[str]):
    if hasattr(node, "name") and node.name == "link":
        url = node.meta.get("url")
        if url:
            links.append(url)
    if hasattr(node, "children") and node.children:
        for child in node.children:
            _extract_links(child, links)


async def _extract_links_from_llm_txt_url(
    llm_text_url: str, max_depth: int = 1, max_urls: int = 1, blocked_domains: list[str] = []
) -> list[tuple[str, str | CrawlerError]]:
    try:
        markdown_text_response = await global_httpx_async_client.get(llm_text_url)
    except httpx.ConnectError:
        return await _deep_crawl_single(
            llm_text_url[: -len(LLM_TXT_URL)], max_depth, max_urls, blocked_domains, special_docs_crawling=False
        )
    markdown_text = markdown_text_response.text
    ast = md.tree(markdown_text)
    links: list[str] = []
    _extract_links(ast, links)

    results = await asyncio.gather(*(global_httpx_async_client.get(link) for link in links), return_exceptions=True)
    failed_links: list[str] = []
    final_results: list[tuple[str, str | CrawlerError]] = []
    for link, result in zip(links, results):
        if isinstance(result, BaseException) or result.is_error:
            failed_links.append(link)
            logging.warning(f"Failed to fetch: {result}")
            continue
        final_results.append((str(result.url), result.text))
    if failed_links:
        logging.info(f"Using default crawler fallback for {len(failed_links)} failed llms.txt links")
        final_results.extend(await crawl_default(failed_links))
    return final_results


async def crawl_llm_txt(
    llm_txt_urls: list[str], max_depth: int = 1, max_urls: int = 1, blocked_domains: list[str] = []
) -> list[tuple[str, str | CrawlerError]]:
    llm_txts = await asyncio.gather(
        *[_extract_links_from_llm_txt_url(url, max_depth, max_urls, blocked_domains) for url in llm_txt_urls]
    )
    all_llm_txts_links = []
    for llm_txts_links in llm_txts:
        all_llm_txts_links.extend(llm_txts_links)

    return all_llm_txts_links


if CRAWL4AI_AVAILABLE:
    class FlowDeepCrawlStrategy(BFSDeepCrawlStrategy):
        async def _arun_batch(
            self,
            start_url: str,
            crawler: AsyncWebCrawler,
            config: CrawlerRunConfig,
        ) -> List[CrawlResult]:
            """
            Batch (non-streaming) mode:
            Processes one BFS level at a time, then yields all the results.
            """
            visited: Set[str] = set()
            # current_level holds tuples: (url, parent_url)
            current_level: List[Tuple[str, Optional[str]]] = [(start_url, None)]
            depths: Dict[str, int] = {start_url: 0}

            results: List[CrawlResult] = []

            while current_level and not self._cancel_event.is_set():
                # Check if we've already reached max_pages before starting a new level
                if self._pages_crawled >= self.max_pages:
                    self.logger.info(f"Max pages limit ({self.max_pages}) reached, stopping crawl")
                    break

                next_level: List[Tuple[str, Optional[str]]] = []
                urls = [url for url, _ in current_level]

                # Clone the config to disable deep crawling recursion and enforce batch mode.
                batch_config = config.clone(deep_crawl_strategy=None, stream=False)

                # FLOWPAD CUSTOM LOGIC:Add dispatcher to avoid cpu issues
                dispatcher = SemaphoreDispatcher(semaphore_count=1, rate_limiter=RateLimiter(max_retries=1))
                batch_results = await crawler.arun_many(urls=urls, config=batch_config, dispatcher=dispatcher)

                # Update pages crawled counter - count only successful crawls
                successful_results = [r for r in batch_results if r.success]  # type: ignore
                self._pages_crawled += len(successful_results)

                for result in batch_results:  # type: ignore
                    url = result.url
                    depth = depths.get(url, 0)
                    result.metadata = result.metadata or {}
                    result.metadata["depth"] = depth
                    parent_url = next((parent for (u, parent) in current_level if u == url), None)
                    result.metadata["parent_url"] = parent_url
                    results.append(result)

                    # Only discover links from successful crawls
                    if result.success:
                        # Link discovery will handle the max pages limit internally
                        await self.link_discovery(result, url, depth, visited, next_level, depths)

                current_level = next_level

            return results
else:
    FlowDeepCrawlStrategy = None
