import asyncio
import logging

import httpx
from bs4 import BeautifulSoup

from flow_sdk.knowledge_engine.crawler.crawl_utils import CrawlerError
from flow_sdk.knowledge_engine.crawler.default_crawler import crawl_default
from flow_sdk.utils import global_httpx_async_client

SITEMAP_URL = "sitemap.xml"


async def _extract_links_from_sitemap(sitemap_url: str) -> list[str]:
    """
    Extracts all links from a sitemap.xml URL using BeautifulSoup,
    handling namespaces gracefully.

    Args:
        sitemap_url: The URL of the sitemap.xml file.

    Returns:
        A list of strings, where each string is a URL found in the sitemap.
        Returns an empty list if there are issues retrieving or parsing the sitemap.
    """
    try:
        response = await global_httpx_async_client.get(sitemap_url)
        response.raise_for_status()

        xml_content = response.text
        soup = BeautifulSoup(xml_content, "xml")  # Use the 'xml' parser

        # Find all <loc> elements, regardless of namespace
        loc_elements = soup.find_all("loc")

        # Extract the text (URL) from each <loc> element
        links = [element.text.strip() for element in loc_elements]

        return links

    except httpx.HTTPError as e:
        logging.error(f"HTTP error fetching sitemap: {e}")
        return []
    except Exception as e:
        logging.error(f"An unexpected error occurred: {e}")
        return []


async def crawl_sitemap(
    sitemap_urls: list[str], max_depth: int = 1, max_urls: int = 1, blocked_domains: list[str] = []
) -> list[tuple[str, str | CrawlerError]]:
    sitemaps_links = await asyncio.gather(*[_extract_links_from_sitemap(url) for url in sitemap_urls])
    all_sitemaps_links = []
    for sitemap_links in sitemaps_links:
        all_sitemaps_links.extend(sitemap_links)

    return await crawl_default(all_sitemaps_links)
