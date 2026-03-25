import asyncio
import json

from flow_sdk.config import default_service_config
from flow_sdk.knowledge_engine.crawler.crawl_utils import CrawlerError
from flow_sdk.utils import global_httpx_async_client

LINKEDIN_PROFILE_URL = "linkedin.com/in"
LINKEDIN_COMPANY_URL = "linkedin.com/company"


async def linkedin_profile_data(linkedin_url: str) -> tuple[str, dict]:
    """
    Search LinkedIn profiles using Proxycurl.
    """
    if not default_service_config.proxycurl_api_url or not default_service_config.proxycurl_api_key:
        raise ValueError("Proxycurl API URL and key must be set in the environment")

    api_endpoint = default_service_config.proxycurl_api_url
    headers = {"Authorization": "Bearer " + default_service_config.proxycurl_api_key}
    params = {
        "linkedin_profile_url": linkedin_url,
    }
    response = await global_httpx_async_client.get(api_endpoint, params=params, headers=headers)
    return linkedin_url, response.json()


async def crawl_linkedin_profile(
    linkedin_urls: list[str], max_depth: int = 1, max_urls: int = 1, blocked_domains: list[str] = []
) -> list[tuple[str, str | CrawlerError]]:
    linkedin_data = await asyncio.gather(*[linkedin_profile_data(url) for url in linkedin_urls], return_exceptions=True)
    # Filter out exceptions
    linkedin_data = [data for data in linkedin_data if not isinstance(data, BaseException)]
    return [
        (url, json.dumps(data, indent=2) if not isinstance(data, Exception) else CrawlerError(message=str(data)))
        for url, data in linkedin_data
    ]


def get_linkedin_user_current_companies_urls(profile_data: dict) -> list[str]:
    return [
        experience["company_linkedin_profile_url"]
        for experience in profile_data.get("experiences", [])
        if experience.get("ends_at", None) is None
    ]


def linkedin_company_name_from_url(company_url: str) -> str:
    return company_url.split("/")[-1].split("?")[0]


def extract_linkedin_interesting_links(linkedin_search_result: dict) -> tuple[str | None, str | None]:
    first_user_url = next(
        (
            item["link"].split("?")[0]
            for item in linkedin_search_result.get("items", [])
            if LINKEDIN_PROFILE_URL in item.get("link", "")
        ),
        None,
    )
    first_company_url = next(
        (
            item["link"].split("?")[0]
            for item in linkedin_search_result.get("items", [])
            if LINKEDIN_COMPANY_URL in item.get("link", "")
        ),
        None,
    )
    return first_user_url, first_company_url
