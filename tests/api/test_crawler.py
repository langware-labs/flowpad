"""
Crawler API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_crawler.py
"""

import pytest

LANGWARE_LINKEDIN_URL = "https://example.com"
ERAN_SHLOMO_LINKEDIN_URL = "https://www.linkedin.com/in/eran-shlomo"

_crawler_import_error = None
try:
    from flow_sdk.knowledge_engine.crawler import crawl
    from flow_sdk.knowledge_engine.crawler.crawler import crawl_single
except ModuleNotFoundError as exc:
    _crawler_import_error = exc
    crawl = None
    crawl_single = None


@pytest.mark.skipif(
    _crawler_import_error is not None,
    reason="Crawler dependencies not installed in this environment",
)
@pytest.mark.skip(reason="External network test - depends on third-party websites availability")
async def test_crawl():
    results = await crawl([LANGWARE_LINKEDIN_URL, "https://www.google.com"], max_depth=1, max_urls=2)
    assert results
    assert len(results) > 2
    assert all(isinstance(result, str) for (_, result) in results)


@pytest.mark.skipif(
    _crawler_import_error is not None,
    reason="Crawler dependencies not installed in this environment",
)
async def test_crawl_single():
    url = "https://example.com"
    crawled_url, result = await crawl_single(url)
    assert crawled_url == url
    assert isinstance(result, str)
    assert result


@pytest.mark.skipif(
    _crawler_import_error is not None,
    reason="Crawler dependencies not installed in this environment",
)
@pytest.mark.skip("Use for evaluating crawler performance")
async def test_crawl_performance():
    results = await crawl(
        [
            "https://jestjs.io/docs/getting-started",
            "https://vitest.dev/guide",
            "https://search.asu.edu/profile/947297",
            "https://www.legacy.com/us/obituaries/name/roy-levi",
            "https://www.instagram.com/leviroycreations/",
            "https://www.facebook.com/levi.yazie/",
            "https://www.google.com",
            "https://json-schema.org/understanding-json-schema/reference/enum",
            LANGWARE_LINKEDIN_URL,
        ]
    )
    assert results
    assert all(isinstance(result, str) for (_, result) in results)


@pytest.mark.skipif(
    _crawler_import_error is not None,
    reason="Crawler dependencies not installed in this environment",
)
@pytest.mark.skip("Skip to avoid proxycurl charges")
async def test_crawl_unblocked():
    result = await crawl([ERAN_SHLOMO_LINKEDIN_URL, LANGWARE_LINKEDIN_URL])
    assert result
    assert len(result) == 2
    assert all(isinstance(result, str) for (_, result) in result)
