"""
LM Proxy Action - Authenticated endpoint for LLM API proxying.

Ported from FlowPad: flowpad/hub/app/actions/lm_proxy.py

Proxies requests to LLM providers (Anthropic, OpenAI) with API key injection.
This action requires FlowPad authentication (API key or JWT token).
LLM provider API keys are read from FlowPad's service configuration.

Action endpoint:
- /api/v1/graph/compute_node/{id}/lm-proxy
- /api/v1/graph/lm-proxy  (global)

Authentication:
- Use Authorization: Bearer {flowpad_api_key} header
- Or use cookies with JWT token from FlowPad session
- For Claude Code on compute nodes: Set ANTHROPIC_BASE_URL='{backend_url}/api/v1/graph/compute_node/{id}/lm-proxy'
                                    Set ANTHROPIC_CUSTOM_HEADERS='Authorization: Bearer {flowpad_api_key}'

Desktop mode: Auth is auto-pass-through (single @local user).
"""

import json
import logging
import os
from typing import AsyncIterator

import httpx
from fastapi import Request, Response
from starlette.responses import StreamingResponse

from flow_sdk.actions import action
from flow_sdk.config import default_service_config
from flow_sdk.request_context.methods import get_current_request_info

logger = logging.getLogger(__name__)

ANTHROPIC_BASE_URL = "https://api.anthropic.com"
OPENAI_BASE_URL = "https://api.openai.com"
DEFAULT_TIMEOUT = 300.0

_http_client: httpx.AsyncClient | None = None


async def get_http_client() -> httpx.AsyncClient:
    """Get or create the global HTTP client."""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
    return _http_client


def log_request(method: str, path: str, headers: dict, body: bytes | None):
    """Log incoming request details with redacted sensitive info."""
    logger.info("=" * 60)
    logger.info("LM_PROXY INCOMING REQUEST")
    logger.info(f"  Method: {method}")
    logger.info(f"  Path: {path}")

    safe_headers = {k: v for k, v in headers.items() if "key" not in k.lower() and "auth" not in k.lower()}
    logger.info(f"  Headers: {json.dumps(safe_headers, indent=2)}")

    if body:
        try:
            body_json = json.loads(body)
            preview = {
                "model": body_json.get("model", "unknown"),
                "max_tokens": body_json.get("max_tokens", "unknown"),
                "message_count": len(body_json.get("messages", [])),
                "stream": body_json.get("stream", False),
            }
            if "system" in body_json:
                preview["has_system"] = True
            logger.info(f"  Body preview: {json.dumps(preview, indent=2)}")
        except json.JSONDecodeError:
            logger.info(f"  Body length: {len(body)} bytes")


def log_response(status: int):
    """Log response details."""
    logger.info("LM_PROXY RESPONSE")
    logger.info(f"  Status: {status}")
    logger.info("=" * 60)


def get_api_key(key_name: str) -> str | None:
    """Get API key from FlowPad service configuration or environment variables."""
    key = None
    if key_name == "ANTHROPIC_API_KEY":
        key = getattr(default_service_config, "anthropic_api_key", None)
    elif key_name == "OPENAI_API_KEY":
        key = getattr(default_service_config, "openai_api_key", None)

    # Fallback to environment variable if not in config
    if not key:
        key = os.getenv(key_name)

    return key


async def stream_proxy(
    method: str,
    url: str,
    headers: dict,
    body: bytes | None,
) -> AsyncIterator[bytes]:
    """Stream response from upstream and yield chunks."""
    client = await get_http_client()
    chunk_count = 0

    async with client.stream(method=method, url=url, headers=headers, content=body) as response:
        logger.info(f"LM_PROXY STREAMING RESPONSE - Status: {response.status_code}")

        if response.status_code >= 400:
            error_body = await response.aread()
            logger.error(f"Upstream error: {error_body.decode()}")
            yield error_body
            return

        async for chunk in response.aiter_bytes():
            chunk_count += 1
            if chunk_count == 1:
                logger.info("  Streaming started - first chunk received")
            yield chunk

        logger.info(f"  Streaming complete - {chunk_count} chunks sent")
        logger.info("=" * 60)


def determine_provider(path: str) -> tuple[str, str, str]:
    """
    Determine the LLM provider and API key name based on the request path.

    Supports two routing methods:
    1. Explicit provider prefix: /anthropic/v1/messages, /openai/v1/chat/completions
    2. Endpoint-based routing: /v1/messages (Anthropic), /v1/chat/completions (OpenAI)

    Returns (base_url, api_key_name, forward_path)
    """
    # Check for explicit provider prefix
    if path.startswith("/anthropic/") or path.startswith("anthropic/"):
        forward_path = path.replace("/anthropic/", "/", 1).replace("anthropic/", "/", 1)
        return ANTHROPIC_BASE_URL, "ANTHROPIC_API_KEY", forward_path
    elif path.startswith("/openai/") or path.startswith("openai/"):
        forward_path = path.replace("/openai/", "/", 1).replace("openai/", "/", 1)
        return OPENAI_BASE_URL, "OPENAI_API_KEY", forward_path

    # Fallback to endpoint-based routing for backward compatibility
    if "/chat/completions" in path:
        return OPENAI_BASE_URL, "OPENAI_API_KEY", path
    else:
        return ANTHROPIC_BASE_URL, "ANTHROPIC_API_KEY", path


@action.all(action_name="lm-proxy")
async def lm_proxy_action(request: Request):
    """
    LM Proxy action - proxies requests to LLM providers.

    Handles:
    - GET /api/v1/graph/lm-proxy (health check)
    - POST /api/v1/graph/lm-proxy/v1/messages (Anthropic)
    - POST /api/v1/graph/lm-proxy/v1/chat/completions (OpenAI)
    """
    # Get sub-path from request context
    request_info = get_current_request_info()
    sub_path = request_info.sub_path if request_info else ""

    # Health check for root path or empty sub_path
    if request.method == "GET" and (not sub_path or sub_path == "/"):
        return {
            "status": "ok",
            "message": "LM Proxy is running",
            "supported_endpoints": [
                "/v1/messages",
                "/v1/chat/completions",
                "/anthropic/v1/messages",
                "/openai/v1/chat/completions",
            ],
        }

    # Proxy request
    body = await request.body()

    log_request(
        method=request.method,
        path=sub_path,
        headers=dict(request.headers),
        body=body if body else None,
    )

    base_url, api_key_name, forward_path = determine_provider(sub_path)

    api_key = get_api_key(api_key_name)
    if not api_key:
        logger.error(f"API key '{api_key_name}' not found in environment")
        return Response(
            content=json.dumps({"error": f"API key '{api_key_name}' not configured"}),
            status_code=500,
            media_type="application/json",
        )

    target_url = f"{base_url}/{forward_path.lstrip('/')}"
    if request.query_params:
        target_url += f"?{request.query_params}"

    headers = {}
    for key, value in request.headers.items():
        if key.lower() in ("host", "transfer-encoding", "connection", "content-length"):
            continue
        headers[key] = value

    if "anthropic" in base_url.lower():
        headers["x-api-key"] = api_key
        headers["anthropic-version"] = headers.get("anthropic-version", "2023-06-01")
    else:
        headers["Authorization"] = f"Bearer {api_key}"

    logger.info(f"  Forwarding to: {target_url}")
    logger.info(f"  API key configured: {api_key[:10]}... (truncated)")

    is_streaming = False
    if body:
        try:
            body_json = json.loads(body)
            is_streaming = body_json.get("stream", False)
        except json.JSONDecodeError:
            pass

    if is_streaming:
        return StreamingResponse(
            stream_proxy(request.method, target_url, headers, body if body else None),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
    else:
        client = await get_http_client()
        response = await client.request(
            method=request.method,
            url=target_url,
            headers=headers,
            content=body if body else None,
        )

        log_response(status=response.status_code)

        response_headers = dict(response.headers)
        response_headers.pop("transfer-encoding", None)
        response_headers.pop("content-encoding", None)

        return Response(
            content=response.content,
            status_code=response.status_code,
            headers=response_headers,
            media_type=response.headers.get("content-type"),
        )
