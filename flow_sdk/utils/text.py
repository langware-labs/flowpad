from __future__ import annotations

import asyncio
import re

import tiktoken


async def count_tokens(texts: str | list[str]) -> int:
    """
    Count the number of tokens in a list of texts using the cl100k_base encoding,
    relevant for both GPT-4 and GPT-3.5-turbo.

    Notes:
    - This function utilizes the `tiktoken` library for encoding and counting tokens.
    """
    if isinstance(texts, str):
        texts = [texts]
    encoder = await asyncio.to_thread(tiktoken.get_encoding, "cl100k_base")
    encodings = encoder.encode_batch(texts)

    return sum([len(enc) for enc in encodings])


def sync_count_tokens(texts: str | list[str]) -> int:
    if isinstance(texts, str):
        texts = [texts]
    encoder = tiktoken.get_encoding("cl100k_base")
    encodings = encoder.encode_batch(texts)

    return sum([len(enc) for enc in encodings])


def sanitize_filename(filename: str, allow_additional_chars: str = "") -> str:
    # Remove any character that is not alphanumeric, a space, or an underscore.
    sanitized = re.sub(rf"[^a-zA-Z0-9_\-{allow_additional_chars}]", "_", filename)
    return sanitized


def tiktoken_truncate(text: str, max_tokens: int) -> str:
    """
    Truncate text to fit within token limit using tiktoken directly.

    Args:
        text: Text to truncate
        max_tokens: Maximum number of tokens allowed

    Returns:
        Truncated text that fits within token limit
    """
    try:
        import tiktoken

        # Use the same encoding as the count_tokens function
        encoder = tiktoken.get_encoding("cl100k_base")

        # Encode text to tokens
        tokens = encoder.encode(text)

        if len(tokens) <= max_tokens:
            return text

        # Truncate at token level
        truncated_tokens = tokens[:max_tokens]

        # Decode back to text
        truncated_text = encoder.decode(truncated_tokens)

        return truncated_text

    except Exception:
        # Fallback: character-based truncation
        estimated_chars = int(max_tokens * 3.5)  # Conservative estimate
        return text[:estimated_chars]


def truncate_tokens(text: str, max_tokens: int) -> str:
    """
    truncate text to fit within token limit.
    Uses tiktoken for precise token-level truncation.

    Args:
        text: Text to truncate
        max_tokens: Maximum number of tokens allowed

    Returns:
        Truncated text that fits within token limit
    """
    current_tokens = sync_count_tokens(text)

    if current_tokens <= max_tokens:
        return text

    # Use tiktoken for precise truncation
    return tiktoken_truncate(text, max_tokens)


def sanitize_for_logging(text: str) -> str:
    """
    Sanitize text for logging to handle Unicode encoding issues on Windows.

    This function attempts to encode the text with cp1252 (Windows console encoding).
    If encoding fails due to Unicode characters, it replaces problematic characters
    with ASCII-safe equivalents.

    Args:
        text: The text to sanitize for logging

    Returns:
        str: Sanitized text that can be safely logged on Windows
    """
    try:
        # Try to encode with the console's encoding to detect issues
        text.encode("cp1252")
        return text
    except UnicodeEncodeError:
        # If encoding fails, replace problematic characters
        return text.encode("ascii", errors="replace").decode("ascii")
