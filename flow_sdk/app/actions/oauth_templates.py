"""HTML templates for OAuth callback responses."""

OAUTH_SUCCESS_HTML = """
<html>
    <head>
        <title>Authorization Successful</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .card {
                background: white;
                padding: 32px 40px;
                border-radius: 12px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                text-align: center;
                max-width: 320px;
            }
            .icon {
                width: 48px;
                height: 48px;
                background: #10b981;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 16px;
            }
            .icon svg { width: 24px; height: 24px; color: white; }
            h1 { font-size: 18px; color: #1f2937; margin-bottom: 8px; }
            p { font-size: 14px; color: #6b7280; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="icon">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
                </svg>
            </div>
            <h1>Authorization Successful</h1>
            <p id="status-msg">This window will close automatically.</p>
        </div>
        <script>
            // Try to close the window after 2 seconds
            setTimeout(() => {
                window.close();
                // If we're still here after 500ms, the close didn't work
                // (happens when opened in external browser via shell.openExternal)
                setTimeout(() => {
                    document.getElementById('status-msg').textContent = 'You may now close this tab.';
                }, 500);
            }, 2000);
        </script>
    </body>
</html>
"""

OAUTH_ERROR_HTML = """
<html>
    <head>
        <title>Authorization Failed</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .card {
                background: white;
                padding: 32px 40px;
                border-radius: 12px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                text-align: center;
                max-width: 320px;
            }
            .icon {
                width: 48px;
                height: 48px;
                background: #ef4444;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 16px;
            }
            .icon svg { width: 24px; height: 24px; color: white; }
            h1 { font-size: 18px; color: #1f2937; margin-bottom: 8px; }
            p { font-size: 14px; color: #6b7280; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="icon">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </div>
            <h1>Authorization Failed</h1>
            <p>Please close this window and try again.</p>
        </div>
    </body>
</html>
"""
