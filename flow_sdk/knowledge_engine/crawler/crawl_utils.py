class CrawlerError(Exception):
    """Custom exception for crawler errors."""

    def __init__(self, message):
        self.message = message
        super().__init__(self.message)
