from unittest.mock import AsyncMock

from flow_sdk.external_apis.email.providers import EmailProvider


class MockEmailSender(EmailProvider):
    def __init__(self, config=None):
        super().__init__(config)
        self.send_email_mock = AsyncMock()

    def set_mock_response(self, response):
        self.send_email_mock.return_value = response

    async def send_email(self, to_email: str, subject: str, html_content: str, name: str | None = None):
        """Properly override the abstract method and call the mock"""
        return await self.send_email_mock(to_email=to_email, subject=subject, html_content=html_content)
