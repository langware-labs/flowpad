"""Speech ↔ text for a recorded clip — what a sound-file call is made of.

A sound file has no provider-held line: the runtime reads the clip, transcribes it, and writes the
reply as a clip beside it. Two calls, both OpenAI's audio endpoints, both on the client a voice
source already holds (``realtime.client_for``).
"""

from __future__ import annotations

from pathlib import Path

TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"
SPEECH_MODEL = "gpt-4o-mini-tts"
SPEECH_VOICE = "marin"


async def transcribe(client, path: Path) -> str:
    """The words in the clip at ``path``."""
    with Path(path).open("rb") as fh:
        result = await client.audio.transcriptions.create(file=fh, model=TRANSCRIBE_MODEL, response_format="text")
    return str(getattr(result, "text", result) or "").strip()


async def speak(client, text: str, out: Path, *, voice: str = SPEECH_VOICE) -> Path:
    """``text`` spoken into a clip at ``out`` (its suffix picks the format: .mp3, .wav, .opus …)."""
    fmt = out.suffix.lstrip(".").lower() or "mp3"
    response = await client.audio.speech.create(model=SPEECH_MODEL, voice=voice, input=text, response_format=fmt)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(response.content)
    return out


__all__ = ["SPEECH_MODEL", "TRANSCRIBE_MODEL", "speak", "transcribe"]
