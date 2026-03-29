"""
Authentication routes for the local server.
"""

import os
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, JSONResponse

from flow_sdk.responses.response import ApiSuccessResponse

from .. import state

router = APIRouter()  # page routes — mounted at root
api_router = APIRouter(prefix="/api/v1/auth")  # API routes — mounted under /api/v1


@router.get("/post_login", response_class=HTMLResponse)
async def post_login(flowpad_api_key: str = Query(None, alias="flowpad-api-key")):
    """
    POST login endpoint that receives an API key.
    Validates the API key and stores it in the system keyring.

    Args:
        flowpad_api_key: The API key from the flowpad-api-key GET parameter

    Returns:
        HTML response with success or error message
    """
    try:
        # Import here to avoid circular dependency
        from flow_sdk.cli.app_config import set_user
        from flow_sdk.cli.auth import set_api_key, validate_api_key

        # Check if API key was provided
        if not flowpad_api_key:
            raise ValueError("No API key provided. Expected 'flowpad-api-key' parameter.")

        # Validate the API key
        user_info = validate_api_key(flowpad_api_key)

        # Store the API key in keyring
        set_api_key(flowpad_api_key)

        # Store user info in app config
        set_user(user_info)

        state.login_result = {"success": True, "user": user_info, "message": "Login successful"}

        # Signal that login was received
        state.login_received.set()

        # Return success HTML
        user_id = user_info.get("id", "Unknown")
        html_content = f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login Successful - Flowpad</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }}
        .container {{
            background: white;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
        }}
        .success-icon {{
            font-size: 64px;
            margin-bottom: 20px;
        }}
        h1 {{
            color: #22c55e;
            margin-bottom: 10px;
        }}
        p {{
            color: #666;
            margin: 10px 0;
        }}
        .info {{
            background: #f0fdf4;
            border-left: 4px solid #22c55e;
            padding: 15px;
            margin: 20px 0;
            text-align: left;
            border-radius: 4px;
        }}
        .close-message {{
            background: #f8fafc;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            padding: 24px;
            margin-top: 40px;
            font-size: 18px;
            font-weight: 600;
            color: #334155;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✓</div>
        <h1>Login Successful!</h1>
        <p>You have been successfully logged in to Flowpad.</p>

        <div class="info">
            <strong>Account Details:</strong><br>
            User ID: {user_id}
        </div>
    </div>

    <div class="close-message">
        ✓ You can now close this browser page
    </div>
</body>
</html>
"""
        return HTMLResponse(content=html_content)

    except Exception as e:
        state.login_result = {"success": False, "error": str(e), "message": "Login failed"}

        # Signal that login was received (even if failed)
        state.login_received.set()

        # Return error HTML
        error_message = str(e)
        html_content = f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login Failed - Flowpad</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }}
        .container {{
            background: white;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
        }}
        .error-icon {{
            font-size: 64px;
            margin-bottom: 20px;
        }}
        h1 {{
            color: #ef4444;
            margin-bottom: 10px;
        }}
        p {{
            color: #666;
            margin: 10px 0;
        }}
        .error-info {{
            background: #fef2f2;
            border-left: 4px solid #ef4444;
            padding: 15px;
            margin: 20px 0;
            text-align: left;
            border-radius: 4px;
        }}
        .close-message {{
            background: #f8fafc;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            padding: 24px;
            margin-top: 40px;
            font-size: 18px;
            font-weight: 600;
            color: #334155;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">✗</div>
        <h1>Login Failed</h1>
        <p>There was an error during login.</p>

        <div class="error-info">
            <strong>Error Details:</strong><br>
            {error_message}
        </div>
    </div>

    <div class="close-message">
        ✓ You can now close this browser page
    </div>
</body>
</html>
"""
        return HTMLResponse(content=html_content, status_code=400)


@router.get("/test_login", response_class=HTMLResponse)
async def test_login():
    """
    Serve the test login HTML page for testing authentication flow.

    Returns:
        HTML response with the test login page
    """
    # Get the path to the HTML file
    server_dir = Path(__file__).parent.parent
    html_file = server_dir / "test_login.html"

    # Read and return the HTML content
    with open(html_file, "r") as f:
        html_content = f.read()

    return HTMLResponse(content=html_content)


@api_router.get("/status")
async def auth_status():
    """Check if user is logged in."""
    try:
        from flow_sdk.cli.app_config import get_user
        from flow_sdk.cli.auth import is_logged_in

        logged_in = is_logged_in()
        user_info = get_user() if logged_in else None

        return ApiSuccessResponse(data={"logged_in": logged_in, "user": user_info})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@api_router.get("/login-url")
async def get_login_url_endpoint():
    """Get the login URL for authentication."""
    try:
        from flow_sdk.cli.env_loader import get_login_url

        port = int(os.environ.get("LOCAL_SERVER_PORT", "9007"))
        callback_url = f"http://127.0.0.1:{port}/post_login"
        login_url = get_login_url(callback_url)

        return ApiSuccessResponse(data={"login_url": login_url})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@api_router.post("/logout")
async def logout():
    """Clear stored API key and user info."""
    try:
        from flow_sdk.cli.app_config import set_user
        from flow_sdk.cli.auth import delete_api_key

        delete_api_key()
        set_user(None)
        state.login_result = None
        state.login_received.clear()
        return ApiSuccessResponse(data={"success": True})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@api_router.post("/refresh-token")
async def refresh_token() -> ApiSuccessResponse[str]:
    """
    Refresh authentication token endpoint.

    For local development, this simply returns a success response with a dummy token.
    In a production environment, this would validate and refresh the JWT token.

    Returns:
        ApiSuccessResponse containing a token string
    """
    # Return a dummy token for local development
    dummy_token = "local_dev_token_refresh"
    return ApiSuccessResponse[str](data=dummy_token)
