"""Typed failures for every LLM call the box makes itself.

Before these, the one shared client (``openai_compatible_completion``) answered an
empty string for *everything* — a timeout, a 401, a model that does not exist, and a
model that genuinely replied with nothing were one value. That is survivable for the
two web-search callers that only ever wanted best-effort prose, and useless for
anything that has to tell the user why their key did not work.

So the primitive raises and the caller decides. The two historical callers keep their
empty-string behaviour by catching :class:`LLMError` locally; everything new (the
endpoint client, the embedder) gets to distinguish "your key is wrong" from "the
model said nothing".

``status`` is the upstream HTTP status when there was one, else ``None``.
"""

from __future__ import annotations


class LLMError(Exception):
    """Base for every failure of an LLM call. Carries the upstream status if there was one."""

    def __init__(self, message: str, *, status: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        #: The upstream error body, truncated by the raiser. Diagnostic only — never parsed.
        self.body = body


class LLMNoCredential(LLMError):
    """No key could be resolved for this endpoint (nothing stored, nothing in the env)."""


class LLMAuthError(LLMError):
    """The provider rejected the credential (401/403)."""


class LLMRateLimited(LLMError):
    """The provider is throttling or the budget is spent (429)."""


class LLMUpstreamError(LLMError):
    """The provider answered an error this layer does not model specially."""


class LLMTimeout(LLMError):
    """The call did not finish inside its ceiling.

    A ceiling, not a retry budget: nothing here widens a wait to make a symptom go away.
    """


class LLMInvalidJSON(LLMError):
    """A JSON reply was asked for and the model did not produce parseable JSON.

    Its own class because the historical primitive answers ``None`` for exactly this and
    ``""`` for every other failure; without the distinction that contract cannot be kept.
    """


class LLMNotSupported(LLMError):
    """This provider's wire protocol has no such operation (Anthropic has no embeddings API)."""


class LLMNotInvocable(LLMError):
    """This endpoint cannot be called in-process at all.

    A ``device`` endpoint is a vendor CLI's own OAuth session: credentials for a terminal,
    not for an API client. The backend can never spend it.
    """


def raise_for_openai(exc: Exception, *, label: str) -> "LLMError":
    """Translate an ``openai`` SDK exception into ours. Returns the error to raise.

    Status-first rather than class-first: the SDK's class hierarchy has changed across
    major versions while the status codes have not.
    """
    status = getattr(exc, "status_code", None)
    body = str(getattr(exc, "body", "") or "")[:500]
    message = f"{label}: {exc}"
    if status in (401, 403):
        return LLMAuthError(message, status=status, body=body)
    if status == 429:
        return LLMRateLimited(message, status=status, body=body)
    if status is not None:
        return LLMUpstreamError(message, status=status, body=body)
    if type(exc).__name__ in ("APITimeoutError", "APIConnectionTimeoutError"):
        return LLMTimeout(message)
    return LLMUpstreamError(message, body=body)


__all__ = [
    "LLMAuthError",
    "LLMError",
    "LLMInvalidJSON",
    "LLMNoCredential",
    "LLMNotInvocable",
    "LLMNotSupported",
    "LLMRateLimited",
    "LLMTimeout",
    "LLMUpstreamError",
    "raise_for_openai",
]
