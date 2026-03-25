"""TeeStream wrapper that writes to both the original stream and a StringIO buffer."""

from io import StringIO


class TeeStream:
    """Wraps a stream, duplicating writes to an internal buffer."""

    def __init__(self, original):
        self.original = original
        self._buf = StringIO()

    def write(self, data):
        n = self.original.write(data)
        try:
            self._buf.write(data)
        except Exception:
            pass
        return n

    def flush(self):
        try:
            self.original.flush()
        except Exception:
            pass

    def fileno(self):
        return self.original.fileno()

    def isatty(self):
        try:
            return self.original.isatty()
        except Exception:
            return False

    def getvalue(self) -> str:
        return self._buf.getvalue()

    def __getattr__(self, name):
        return getattr(self.original, name)
