from abc import ABC, abstractmethod


class EmailProvider(ABC):
    def __init__(self, config):
        self.config = config
        self.name: str | None = None

    @abstractmethod
    async def send_email(self, to_email: str, subject: str, html_content: str, name: str = None):
        raise NotImplementedError
