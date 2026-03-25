import asyncio
import logging
import re
import time
import warnings
from typing import Literal
from urllib.parse import urljoin, urlparse

import aiohttp
from bs4 import BeautifulSoup, Tag

from flow_sdk.external_apis.search.web_search import DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS
from flow_sdk.utils.text import count_tokens, truncate_tokens

try:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
        from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    CRAWL4AI_AVAILABLE = True
except ImportError:
    CRAWL4AI_AVAILABLE = False
    AsyncWebCrawler = None
    BrowserConfig = None
    CacheMode = None
    CrawlerRunConfig = None
    DefaultMarkdownGenerator = None

# Web Content Fetching Configuration
WEB_FETCH_TIMEOUT = 30  # seconds
WEB_FETCH_MAX_SIZE = 10 * 1024 * 1024  # 10MB max content size
WEB_FETCH_USER_AGENT = "FlowPad-Agent/1.0 (Web Content Fetcher)"


async def _apply_token_limit(content: str, source_url: str, max_tokens: int) -> str:
    """
    Apply token limit to fetched content if it exceeds the specified max_tokens.

    Args:
        content: The content to potentially truncate
        source_url: URL for logging purposes
        max_tokens: Maximum number of tokens allowed

    Returns:
        Content truncated to fit within token limits if necessary
    """
    try:
        current_tokens = await count_tokens(content)

        if current_tokens <= max_tokens:
            return content

        logging.warning(
            f"⚠️  Content from {source_url} has {current_tokens} tokens, truncating to user limit of {max_tokens}"
        )
        truncated_content = truncate_tokens(content, max_tokens)

        final_tokens = await count_tokens(truncated_content)
        logging.info(f"📏 Truncated content to {final_tokens} tokens")

        return truncated_content

    except Exception as e:
        logging.error(f"Error applying token limit to content from {source_url}: {e}")
        # Return original content if token limiting fails
        return content


async def fetch_web_content(
    url: str,
    fetch_mode: Literal["html", "markdown"] = "html",
    enable_javascript: bool = False,
    max_output_tokens: int | None = None,
) -> str:
    """
    Fetch and extract readable content from a web page.

    Priority order:
    1. Check for /llms.txt first - if available, fetch that instead
    2. Use the specified fetch_mode (html or markdown)

    Args:
        url: The URL to fetch content from
        fetch_mode: "html" for BeautifulSoup parsing, "markdown" for crawl4ai markdown extraction
        enable_javascript: If True, enables JavaScript rendering with Playwright (slower but more content)
        max_output_tokens: Maximum tokens allowed for output, uses default if None

    Returns:
        Extracted and cleaned content from the web page
    """
    # Use default value if max_output_tokens is not provided
    if max_output_tokens is None:
        max_output_tokens = DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS

    # Validate URL
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError(f"Invalid URL format: {url}")

        if parsed.scheme not in ["http", "https"]:
            raise ValueError(f"Only HTTP and HTTPS URLs are supported: {url}")

    except Exception as e:
        logging.error(f"❌ Invalid URL '{url}': {str(e)}")
        error_msg = f"Error: Invalid URL format - {str(e)}"
        return await _apply_token_limit(error_msg, url, max_output_tokens)

    logging.info(f"🌐 Fetching web content from: {url} (mode: {fetch_mode}, javascript: {enable_javascript})")
    logging.info(
        f"🔧 Fetch parameters: fetch_mode={fetch_mode}, enable_javascript={enable_javascript}, timeout={WEB_FETCH_TIMEOUT}s"
    )
    logging.info(f"📋 Config: timeout={WEB_FETCH_TIMEOUT}s, max_size={WEB_FETCH_MAX_SIZE // 1024 // 1024}MB")

    # Step 1: Check for llms.txt first (highest priority)
    llms_txt_url = urljoin(url.rstrip("/") + "/", "llms.txt")
    llms_txt_content = await _try_fetch_llms_txt(llms_txt_url)
    if llms_txt_content:
        logging.info(f"✅ Found llms.txt at {llms_txt_url}")
        full_content = f"# Content from {llms_txt_url}\n\n{llms_txt_content}"
        return await _apply_token_limit(full_content, llms_txt_url, max_output_tokens)

    # Step 2: Use specified fetch mode
    if fetch_mode == "markdown":
        content = await _fetch_with_crawl4ai(url, enable_javascript)
        return await _apply_token_limit(content, url, max_output_tokens)
    else:
        content = await _fetch_with_html_parsing(url)
        return await _apply_token_limit(content, url, max_output_tokens)


async def _try_fetch_llms_txt(llms_txt_url: str) -> str | None:
    """
    Try to fetch llms.txt from the given URL.
    Returns the content if successful, None if not found or error.
    """
    try:
        headers = {
            "User-Agent": WEB_FETCH_USER_AGENT,
            "Accept": "text/plain,*/*;q=0.8",
        }

        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=10),  # Shorter timeout for llms.txt check
            headers=headers,
        ) as session:
            async with session.get(llms_txt_url) as response:
                if response.status == 200:
                    content_type = response.headers.get("content-type", "").lower()
                    if "text" in content_type or not content_type:
                        content = await response.text(errors="ignore")
                        if content.strip():  # Only return if there's actual content
                            return content.strip()
                return None

    except Exception as e:
        logging.info(f"Could not fetch llms.txt from {llms_txt_url}: {e}")
        return None


async def _fetch_with_crawl4ai(url: str, enable_javascript: bool = False) -> str:
    """
    Fetch content using crawl4ai with markdown extraction.

    Args:
        url: The URL to fetch content from
        enable_javascript: If True, enables JavaScript rendering with Playwright
    """
    if not CRAWL4AI_AVAILABLE:
        logging.warning("crawl4ai not available, falling back to HTML parsing")
        return await _fetch_with_html_parsing(url)

    start_time = time.time()

    js_status = "with JavaScript" if enable_javascript else "JavaScript disabled"
    logging.info(f"🕷️ Fetching with crawl4ai (markdown mode + DefaultMarkdownGenerator, {js_status}): {url[:60]}...")

    try:
        # Configure for markdown extraction with optional JavaScript
        config = BrowserConfig(
            headless=True, text_mode=True, light_mode=True, verbose=False, java_script_enabled=enable_javascript
        )
        run_config = CrawlerRunConfig(
            cache_mode=CacheMode.ENABLED,
            only_text=True,
            remove_overlay_elements=True,
            page_timeout=5000,  # 5 second page load timeout
            delay_before_return_html=0,
        )

        async with AsyncWebCrawler(config=config) as crawler:
            # Create markdown generator for better markdown extraction
            md_generator = DefaultMarkdownGenerator()

            result = await asyncio.wait_for(
                crawler.arun(url, config=run_config, markdown_generator=md_generator),
                timeout=8.0,  # 8 second max timeout
            )

            crawl_time = time.time() - start_time
            logging.info(f"🕒 Crawl4ai completed in {crawl_time:.2f}s for {url}")

            # Extract markdown content safely
            try:
                content = (
                    getattr(result, "markdown", None)
                    or getattr(result, "cleaned_html", None)
                    or getattr(result, "text", None)
                    or "_No content extracted_"
                )
                content = content.strip() if isinstance(content, str) else str(content)

                logging.info(f"📄 Crawl4ai extracted {len(content)} characters from {url}")

                js_mode = " + JavaScript" if enable_javascript else ""
                return f"# Content from {url}\n**Extracted via crawl4ai (markdown mode with DefaultMarkdownGenerator{js_mode})**\n\n{content}"

            except AttributeError as e:
                return f"Error: Content extraction failed - {str(e)}"

    except asyncio.TimeoutError:
        crawl_time = time.time() - start_time
        logging.warning(f"Crawl4ai timeout for {url} after {crawl_time:.2f}s")
        return f"Error: Crawl4ai timed out after {crawl_time:.2f}s"

    except Exception as e:
        crawl_time = time.time() - start_time
        logging.error(f"Crawl4ai failed for {url} in {crawl_time:.2f}s: {e}")
        return f"Error: Crawl4ai failed - {str(e)}"


async def _fetch_with_html_parsing(url: str) -> str:
    """
    Fetch content using aiohttp and BeautifulSoup HTML parsing (original implementation).
    """
    logging.info(f"🌐 Fetching with HTML parsing: {url[:60]}...")

    try:
        headers = {
            "User-Agent": WEB_FETCH_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
        }

        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=WEB_FETCH_TIMEOUT), headers=headers
        ) as session:
            async with session.get(url) as response:
                # Check response status
                if response.status != 200:
                    error_msg = f"HTTP {response.status}: {response.reason}"
                    logging.error(f"❌ Failed to fetch {url}: {error_msg}")
                    return f"Error: Failed to fetch page - {error_msg}"

                # Check content type
                content_type = response.headers.get("content-type", "").lower()
                if "text/html" not in content_type and "application/xhtml" not in content_type:
                    logging.warning(f"⚠️  Non-HTML content type: {content_type}")

                # Check content size
                content_length = response.headers.get("content-length")
                if content_length and int(content_length) > WEB_FETCH_MAX_SIZE:
                    error_msg = f"Content too large ({content_length} bytes > {WEB_FETCH_MAX_SIZE})"
                    logging.error(f"❌ {error_msg}")
                    return f"Error: {error_msg}"

                # Read content with size limit
                content = await response.text(errors="ignore")

                if len(content) > WEB_FETCH_MAX_SIZE:
                    logging.warning(f"⚠️  Truncating large content ({len(content)} chars)")
                    content = content[:WEB_FETCH_MAX_SIZE]

                logging.info(f"✅ Successfully fetched {len(content)} characters from {url}")

                # Parse HTML and extract readable content
                soup = BeautifulSoup(content, "html.parser")

                # Remove script and style elements
                for script in soup(["script", "style", "nav", "header", "footer", "aside", "noscript"]):
                    script.decompose()

                # Extract title
                title = ""
                title_tag = soup.find("title")
                if title_tag:
                    title = title_tag.get_text(strip=True)

                # Extract meta description
                description = ""
                meta_desc = soup.find("meta", attrs={"name": "description"})
                if isinstance(meta_desc, Tag):
                    content_attr = meta_desc.get("content")
                    if content_attr:
                        description = str(content_attr).strip()

                # Extract main content
                # Try to find main content containers first
                main_content = None
                for selector in ["main", "article", '[role="main"]', ".content", ".post", ".entry"]:
                    main_content = soup.select_one(selector)
                    if main_content:
                        break

                # If no main container found, use body
                if not main_content:
                    main_content = soup.find("body") or soup

                # Extract text content
                text_content = main_content.get_text(separator="\n", strip=True)

                # Clean up the text
                # Remove excessive whitespace
                text_content = re.sub(r"\n\s*\n", "\n\n", text_content)
                text_content = re.sub(r"[ \t]+", " ", text_content)

                # Build final result
                result_parts = []

                if title:
                    result_parts.append(f"Title: {title}")

                if description:
                    result_parts.append(f"Description: {description}")

                result_parts.append(f"URL: {url}")
                result_parts.append(f"Content Length: {len(text_content)} characters")
                result_parts.append("**Extracted via HTML parsing**")
                result_parts.append("---")
                result_parts.append(text_content)

                final_result = "\n".join(result_parts)

                # Log extraction results
                logging.info("📄 Extracted content summary:")
                logging.info(f"   📌 Title: {title or 'No title found'}")
                logging.info(f"   📝 Description: {description or 'No description'}")
                logging.info(f"   📊 Content: {len(text_content)} characters")

                logging.info(f"✅ HTML parsing completed ({len(text_content)} chars)")
                return final_result

    except aiohttp.ClientError as e:
        error_msg = f"Network error: {str(e)}"
        logging.error(f"❌ Failed to fetch {url}: {error_msg}")
        return f"Error: {error_msg}"
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        logging.error(f"❌ Failed to fetch {url}: {error_msg}")
        return f"Error: {error_msg}"
