import traceback
from typing import Optional, Protocol

from httpx import AsyncClient
from sendgrid import Mail

from flow_sdk.config import EmailProviderType
from flow_sdk import service_log

from ..email_provider import EmailProvider


class SupportsGet(Protocol):
    def get(self) -> dict:
        pass


class SendGridAPIClient:
    def __init__(
        self,
        api_key: str,
        impersonate_subuser: Optional[str] = None,
        host: str = "https://api.sendgrid.com/v3",
        session=None,
        timeout=None,
    ):
        """
        Construct the Twilio SendGrid v3 API object.
        Note that the underlying client is being set up during initialization,
        therefore changing attributes in runtime will not affect HTTP client
        behaviour.

        :param api_key: the api_key to use in the authorization header
        :type api_key: string
        :param impersonate_subuser: the subuser to impersonate. Will be passed
            by "On-Behalf-Of" header by underlying client.
            See https://sendgrid.com/docs/User_Guide/Settings/subusers.html
            for more details
        :type impersonate_subuser: string
        :param host: base URL for API calls
        :type host: string
        """

        self.host = host
        self.session = session
        self.timeout = timeout
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "*/*",
            "Content-Type": "application/json",
        }
        if impersonate_subuser:
            self.headers["On-Behalf-Of"] = impersonate_subuser

    async def __aenter__(self):
        await self.open()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()

    async def open(self):
        if self.session is None:
            self.session = AsyncClient(headers=self.headers, http2=True)

    async def close(self):
        if self.session is not None:
            await self.session.aclose()
            self.session = None

    async def send(self, message: dict | SupportsGet):
        """
        Make a Twilio SendGrid v3 API request with the request body generated
        by the Mail object

        :param message: The Twilio SendGrid v3 API request body generated
            by the Mail object or dict
        """
        try:
            url = f"{self.host}/mail/send"
            if not isinstance(message, dict):
                message = message.get()

            await self.open()
            response = await self.session.post(url=url, json=message)
            if response.status_code == 202:
                return {}

            return await response.json()
        except Exception as e:
            service_log.error(f"Error sending email using sendgrid: {e}")
            return None


class SendGridEmailSender(EmailProvider):
    def __init__(self, config):
        super().__init__(config)
        self.name = EmailProviderType.SENDGRID
        self.client = SendGridAPIClient(self.config.sendgrid_api_key)

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        name: str = None,
    ):
        from_email = f"via FlowPad <{self.config.no_reply_email}>"
        if name:
            from_email = f"{name} via FlowPad <{self.config.no_reply_email}>"

        message = Mail(
            from_email=from_email,
            to_emails=to_email,
            subject=subject,
            html_content=html_content,
        )
        try:
            async with self.client as client:
                response = await client.send(message)
            return response
        except Exception as e:
            if self.config.is_local_or_development:
                traceback.print_exc()
            service_log.highlighted_error(f"invite: Error in invite: {e}")
            raise e
