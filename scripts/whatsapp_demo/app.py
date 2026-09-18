"""Small Twilio WhatsApp transport demo; replies are scripted, not AI-generated."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
from urllib.parse import parse_qs
from xml.etree.ElementTree import Element, SubElement, tostring

from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Request, Response


def reply_to(body: str) -> str:
    text = body.strip()
    if text.lower().startswith('echo '):
        return text[5:].strip() or 'Send echo followed by some text.'
    if text.lower() in {'hi', 'hello', 'hey'}:
        return 'Hello! Your WhatsApp message reached the Flowpad demo. Send help to see what I can do.'
    return 'WhatsApp connection demo (scripted replies):\nhello — say hello\necho <text> — send your text back\nhelp — show these commands'


def create_app(auth_token: str, account_sid: str, webhook_url: str) -> FastAPI:
    if not auth_token or not account_sid or not webhook_url.startswith('https://'):
        raise ValueError('Provide Twilio auth token, account SID, and the exact public HTTPS webhook URL.')
    app = FastAPI()

    @app.get('/health')
    async def health():
        return {'status': 'ok', 'demo': 'whatsapp', 'replies': 'scripted'}

    @app.post('/whatsapp')
    async def whatsapp(request: Request):
        params = parse_qs((await request.body()).decode('utf-8'), keep_blank_values=True)
        # Twilio signs the exact public URL plus sorted form keys and values.
        signed = webhook_url + ''.join(k + v for k in sorted(params) for v in sorted(set(params[k])))
        expected = base64.b64encode(hmac.new(auth_token.encode(), signed.encode(), hashlib.sha1).digest()).decode()
        if not hmac.compare_digest(expected, request.headers.get('X-Twilio-Signature', '')):
            raise HTTPException(403, 'Invalid Twilio signature')
        if params.get('AccountSid') != [account_sid]:
            raise HTTPException(403, 'Unexpected Twilio account')
        if not params.get('From', [''])[0].startswith('whatsapp:'):
            raise HTTPException(400, 'Expected a WhatsApp message')
        response = Element('Response')
        SubElement(response, 'Message').text = reply_to(params.get('Body', [''])[0])
        return Response(tostring(response, encoding='unicode'), media_type='application/xml')

    return app


if __name__ == '__main__':
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True, help='Existing env file containing Twilio credentials')
    parser.add_argument('--webhook-url', required=True, help='Exact public HTTPS URL ending in /whatsapp')
    parser.add_argument('--port', type=int, default=6081)
    args = parser.parse_args()
    config = dotenv_values(args.env_file)
    app = create_app(config.get('TWILIO_AUTH_TOKEN', ''), config.get('TWILIO_ACCOUNT_SID', ''), args.webhook_url)
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)
