import asyncio
from typing import Awaitable, Callable, Literal

from flow_sdk.config import default_service_config
from flow_sdk.knowledge_engine.crawler.crawl_utils import CrawlerError
from flow_sdk.knowledge_engine.crawler.default_crawler import LLM_TXT_URL, crawl_llm_txt, deep_crawl_default
from flow_sdk.knowledge_engine.crawler.sitemap_crawler import SITEMAP_URL, crawl_sitemap
from flow_sdk.utils import global_httpx_async_client

CUSTOM_CRAWLERS: dict[
    str, Callable[[list[str], int, int, list[str]], Awaitable[list[tuple[str, str | CrawlerError]]]]
] = {
    SITEMAP_URL: crawl_sitemap,
    LLM_TXT_URL: crawl_llm_txt,
}


async def crawl(
    urls: list[str], max_depth: int = 0, max_urls: int = 1, blocked_domains: list[str] = []
) -> list[tuple[str, str | CrawlerError]]:
    """
    Crawl a list of URLs and return the markdown content
    """
    urls_per_crawler = {}
    for url in urls:
        for crawler_name, crawler_func in CUSTOM_CRAWLERS.items():
            if crawler_name in url:
                urls_per_crawler.setdefault(crawler_name, []).append(url)
                break
        else:
            urls_per_crawler.setdefault("default", []).append(url)
    results_lists = await asyncio.gather(
        *[
            crawler_func(urls, max_depth, max_urls, blocked_domains)
            for crawler_name, urls in urls_per_crawler.items()
            if (crawler_func := CUSTOM_CRAWLERS.get(crawler_name, deep_crawl_default))
        ]
    )
    results = []
    for results_list in results_lists:
        results += results_list
    return results


async def crawl_single(url: str) -> tuple[str, str | CrawlerError]:
    """
    Crawl a single URL and return the markdown content
    """
    return (await crawl([url]))[0]


async def search(
    query: str,
    site_search: str | None = None,
    site_search_filter: Literal["i", "e"] | None = None,
    num_results: int | None = None,
    **search_params,
) -> dict:
    """
    See possible search parameters at:
    https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list
    """
    url = default_service_config.google_search_url
    if not url:
        raise Exception("Google search URL is not set in the environment")
    params = {
        "key": default_service_config.google_search_key,
        "cx": default_service_config.google_search_context,
        "q": query,
        **search_params,
    }

    if site_search:
        params["siteSearch"] = site_search

    if site_search_filter:
        params["siteSearchFilter"] = site_search_filter

    if num_results:
        params["num"] = num_results

    result = await global_httpx_async_client.get(
        url,
        params=params,
    )
    return result.json()
