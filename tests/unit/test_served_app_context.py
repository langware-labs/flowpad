"""A static app's local hash navigation retains its launch context."""
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from starlette.requests import Request

from flow_sdk.builtin.faas.serve_static import serve_app_bytes


async def test_hash_links_keep_launch_context_without_changing_asset_urls(tmp_path):
    (tmp_path / 'index.html').write_text('<html><head></head><body><a href="#devices">Devices</a></body></html>')
    root = 'http://localhost/api/v1/graph/service_endpoint/app/service/'
    query = 'consumerProject=consumer&providerProject=provider&subject=a%26b'
    request = Request({'type': 'http', 'scheme': 'http', 'server': ('localhost', 80),
                       'path': '/api/v1/graph/service_endpoint/app/service/',
                       'query_string': query.encode(), 'headers': []})
    response = await serve_app_bytes(tmp_path, None, request, base_url=root)
    html = BeautifulSoup(response.body, 'html.parser')
    base = html.base['href']
    assert urljoin(base, html.a['href']) == f'{root}?{query}#devices'
    assert urljoin(base, './app.js') == f'{root}app.js'
