import asyncio
from typing import List, Optional

from pydantic import BaseModel, Field

from flow_sdk.external_apis.llm.llm_connector import send_request_to_llm
from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMResponse
from flow_sdk.external_apis.llm.utils import clean_json_completion, typed_messages
from flow_sdk.knowledge_engine.crawler import crawl_single, search
from flow_sdk.knowledge_engine.crawler.linkedin_crawler import (
    extract_linkedin_interesting_links,
    get_linkedin_user_current_companies_urls,
    linkedin_company_name_from_url,
    linkedin_profile_data,
)


class PersonDetailsInput(BaseModel):
    name: Optional[str] = None
    company_name: Optional[str] = None
    work_email: Optional[str] = None
    raw_info: Optional[str] = None
    profile_data: Optional[dict] = Field(description="The profile data of the person", default=None)
    companies_sites: Optional[List[str]] = Field(
        description="The site of the companies the user is currently working at", default=None
    )


class PersonaDetailOutput(BaseModel):
    first_name: Optional[str] = None
    middle_name: Optional[str] = None
    last_name: Optional[str] = None
    work_email: Optional[str] = None

    company_name: Optional[str] = None
    about_me: Optional[str] = Field(description="A short professional description about the person", default=None)
    about_company: Optional[str] = Field(
        description="A short professional description about the company we are interested in", default=None
    )
    about_job: Optional[str] = Field(
        description="A short professional description about the person job in the coompany we are interested in",
        default=None,
    )

    my_story: Optional[str] = Field(
        description="A 5 sentence story about the professional journey of the person", default=None
    )

    location: Optional[str] = Field(description="The location of the person", default=None)
    industry: Optional[str] = Field(description="The industry of the company we are interested in", default=None)

    my_social_media_links: Optional[dict[str, str]] = Field(
        description="The social media links of the person with the platform as key and the link as value",
        default=None,
    )
    company_social_media_links: Optional[dict[str, str]] = Field(
        description="The social media links of the company we are interested in with the platform as key and the link as value",
        default=None,
    )


async def persona_details_generator(
    name: Optional[str] = None,
    company_name: Optional[str] = None,
    work_email: Optional[str] = None,
    raw_info: Optional[str] = None,
    _verbose: bool = False,
) -> PersonaDetailOutput:
    search_query = ""
    if name:
        search_query += name
    if company_name:
        search_query += " " + company_name
    if work_email:
        search_query += " " + work_email
    if raw_info:
        search_query += " " + raw_info

    if not (name and company_name) and not work_email and not raw_info:
        raise ValueError(
            "At least one of the following must be provided: (name and company_name) or (work_email) or (raw_info)"
        )

    search_result = await search(search_query, siteSearch="linkedin.com", siteSearchFilter="i")
    user_url, company_url = extract_linkedin_interesting_links(search_result)

    async def returns_none():
        return None

    crawling_jobs = [
        linkedin_profile_data(user_url) if user_url else returns_none(),
        crawl_single(company_url) if company_url else returns_none(),
    ]
    (_, profile_data), (_, company_site) = await asyncio.gather(*crawling_jobs)
    companies_sites = []
    if company_site:
        companies_sites.append(company_site)
    if profile_data:
        # Crawl all current companies of the user
        current_companies_urls = get_linkedin_user_current_companies_urls(profile_data)
        company_site_crawling_jobs = [
            crawl_single(current_company_url)
            for current_company_url in current_companies_urls
            if company_url is None
            or (
                current_company_url is not None
                and linkedin_company_name_from_url(current_company_url) != linkedin_company_name_from_url(company_url)
            )
        ]
        if company_site_crawling_jobs:
            companies_sites.extend(await asyncio.gather(*company_site_crawling_jobs))
            companies_sites = [s for (_, s) in companies_sites if isinstance(s, str)]

    persona_input = PersonDetailsInput(
        name=name,
        company_name=company_name,
        work_email=work_email,
        raw_info=raw_info,
        profile_data=profile_data,
        companies_sites=companies_sites,
    )

    messages = typed_messages(
        input_schema=PersonDetailsInput.model_json_schema(),
        output_schema=PersonaDetailOutput.model_json_schema(),
        input_data=persona_input.model_dump(),
    )
    llm_response: LLMResponse = await send_request_to_llm(messages, json_output=True, verbose=_verbose)
    llm_response_json = clean_json_completion(llm_response.completion)
    persona_details = PersonaDetailOutput(**llm_response_json)

    # Add the known variables to the persona details
    if user_url:
        if not persona_details.my_social_media_links:
            persona_details.my_social_media_links = {}
        persona_details.my_social_media_links["linkedin"] = user_url
    if company_url:
        if not persona_details.company_social_media_links:
            persona_details.company_social_media_links = {}
        persona_details.company_social_media_links["linkedin"] = company_url
    if work_email:
        persona_details.work_email = work_email

    return persona_details
