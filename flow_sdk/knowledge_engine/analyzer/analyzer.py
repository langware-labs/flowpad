import asyncio
import json
import re
import textwrap
from typing import Any, List, TypeVar

from pydantic import BaseModel, Field

from flow_sdk.config import default_service_config
from flow_sdk import service_log
from flow_sdk.builtin.fs_entities import FSItem
from flow_sdk.builtin.page import Page
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import (
    get_current_workspace_typeid,
)
from flow_sdk.external_apis.llm.llm_connector import send_request_to_llm
from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMProvider, LLMResponse
from flow_sdk.external_apis.llm.utils import clean_json_completion, typed_messages
from flow_sdk.external_apis.llm.utils.utils import clean_fenced_completion
from flow_sdk.knowledge_engine.analyzer.top_words import get_top_words
from flow_sdk.knowledge_engine.knowledge_engine import query_knowledge
from flow_sdk.knowledge_engine.prompts import RESOLVE_HINTS_PROMPT

T = TypeVar("T")


def filter_is_not_exception(items: List[T | BaseException]) -> List[T]:
    return [x for x in items if not isinstance(x, BaseException)]


class RelevantLinksInput(BaseModel):
    query_string: str = Field(description="The user's query string")
    search_results: Any = Field(description="The search results")


class RelevantLinksOutput(BaseModel):
    relevant_links: List[str] = Field(description="List of relevant links")


async def understand_relevant_links(info: str, search_results: Any) -> RelevantLinksOutput:
    instruction = textwrap.dedent(
        """
        You are tasked with identifying relevant links based on the user's query and search results.
        Given the query and search results, list the relevant links.
        """
    )

    messages = typed_messages(
        instruction=instruction,
        input_schema=RelevantLinksInput.model_json_schema(),
        output_schema=RelevantLinksOutput.model_json_schema(),
        input_data=RelevantLinksInput(query_string=info, search_results=search_results).model_dump(),
    )
    # not clear why groq model is forced here
    # [ERROR] Error with model groq: Input tokens 8936 exceed the limit of 7000. Skipping.
    # llm_response: LLMResponse = await send_request_to_llm(messages, LLMProvider.Groq, json_output=True)
    llm_response: LLMResponse = await send_request_to_llm(messages, json_output=True)
    try:
        response = clean_json_completion(llm_response.completion)
    except json.JSONDecodeError:
        response = llm_response.completion

    return RelevantLinksOutput.model_validate(response)


class TemplateAnalyzerInput(BaseModel):
    related_sources: List[str] = Field(description="The sources related to the page")
    page_template_markdown: str = Field(description="The markdown content of the page template to fill")


async def template_analyze(
    target_page: Page, context_entities: List[Entity] | None = None, context_strings: List[str] | None = None
) -> str:
    workspace_typeid = get_current_workspace_typeid()
    if not workspace_typeid:
        raise ValueError("No workspace typeid found")
    if not context_entities:
        context_entities = []
    if not context_strings:
        context_strings = []
    context_strings = [re.sub(r"\s+", " ", string) for string in context_strings]
    context_strings = [string for string in context_strings if string]
    # I don't currently need the template page as I'm only using the target page itself to analyze
    target_page_markdown = target_page.markdown_content

    context_pages = [entity for entity in context_entities if isinstance(entity, Page)]

    # Get the markdown content of the context pages
    async def get_page_content_with_title(page: Page) -> str:
        await page.expand_blobs()
        content = page.markdown_content
        return f"# {page.title}\n{content}"

    # Fetch all the knowledge entities and chunks
    # TODO query knowledge with less text, not whole markdowns
    context_pages_markdowns, knowledge = await asyncio.gather(
        asyncio.gather(*[get_page_content_with_title(page) for page in context_pages]),
        asyncio.gather(
            *[
                query_knowledge(
                    " ".join((await get_top_words(target_page_markdown))[0]),
                    workspace_typeid,
                    [page.typeid],
                    default_service_config.knowledge_default_num_of_results,
                )
                for page in context_pages
            ],
            query_knowledge(
                " ".join((await get_top_words(target_page_markdown))[0]),
                workspace_typeid,
                [target_page.typeid],
                default_service_config.knowledge_default_num_of_results,
            ),
            *[
                query_knowledge(
                    " ".join((await get_top_words(ctx_string))[0]),
                    workspace_typeid,
                    [target_page.typeid],
                    default_service_config.knowledge_default_num_of_results,
                )
                for ctx_string in context_strings
            ],
            return_exceptions=True,
        ),
    )
    all_knowledge_chunks: List[FSItem] = []
    for query_knowledge_chunks in filter_is_not_exception(knowledge):
        all_knowledge_chunks.extend(query_knowledge_chunks)
    all_knowledge_chunks = list(set(all_knowledge_chunks))

    # Chunk strings
    chunk_strings = []
    sorted_knowledge_chunks = sorted(all_knowledge_chunks, key=lambda x: (x.vfs_abs_path, x.offset))
    await asyncio.gather(*[chunk.download() for chunk in sorted_knowledge_chunks])
    for chunk in sorted_knowledge_chunks:
        try:
            chunk_strings.append(chunk.content)
        except Exception as e:
            service_log.error(f"Error getting content for {chunk.vfs_abs_path}: {e}")

    # Send the request to the LLM
    instruction = textwrap.dedent(
        f"""
        You are tasked with filling in a page template based on the related entities, relationships, and sources provided. 
        Given the related entities, relationships, and sources, fill in the page template with the appropriate content.
        {RESOLVE_HINTS_PROMPT}
        """
    )

    messages = typed_messages(
        instruction=instruction,
        input_schema=TemplateAnalyzerInput.model_json_schema(),
        output_schema={
            "type": "string",
            "description": "The full string markdown content of the page as per the template but leave out unknowns. make it rich and full of known value. The input is given as json but your output should be regular markdown",
        },
        input_data=TemplateAnalyzerInput(
            related_sources=chunk_strings + context_pages_markdowns + context_strings,
            page_template_markdown=target_page_markdown,
        ).model_dump(),
    )
    filled_template: LLMResponse = await send_request_to_llm(messages, LLMProvider.VertexAI)
    return clean_fenced_completion(filled_template.completion)
