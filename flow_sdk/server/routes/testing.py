"""
Testing/debugging routes for the local server.
"""

import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import state

router = APIRouter()


@router.get("/ping")
async def ping(ping_str: str):
    """
    Ping endpoint that receives a ping string for testing hooks.

    Args:
        ping_str: The ping string to store

    Returns:
        JSON response with success status
    """
    result = {
        "success": True,
        "ping_str": ping_str,
        "timestamp": time.time()
    }

    # Store the ping result
    state.ping_results.append(result)

    # Signal that ping was received
    state.ping_received.set()

    return JSONResponse(content=result)


@router.get("/get_pings")
async def get_pings():
    """
    Get all received pings.

    Returns:
        JSON response with all ping results
    """
    return JSONResponse(content={"pings": state.ping_results})


@router.get("/prompt")
async def prompt(prompt_text: str):
    """
    Prompt endpoint that receives a user prompt for testing hooks.

    Args:
        prompt_text: The prompt text to store

    Returns:
        JSON response with success status
    """
    result = {
        "success": True,
        "prompt_text": prompt_text,
        "timestamp": time.time()
    }

    # Store the prompt result
    state.prompt_completions.append(result)

    # Signal that prompt was received
    state.prompt_received.set()

    return JSONResponse(content=result)


@router.get("/get_prompts")
async def get_prompts():
    """
    Get all received prompts.

    Returns:
        JSON response with all prompt results
    """
    return JSONResponse(content={"prompts": state.prompt_completions})
