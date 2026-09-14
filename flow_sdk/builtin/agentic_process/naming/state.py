"""Pure worker-independent session naming policy.

Provider adapters supply evidence, never authority decisions. Unknown evidence
is imported conservatively and protected because a persisted provider title may
have been entered by a person.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class NamePhase(str, Enum):
    UNNAMED = "unnamed"
    PROMPT_FALLBACK = "prompt_fallback"
    HARNESS = "harness"
    USER_PINNED = "user_pinned"
    PROTECTED_UNKNOWN = "protected_unknown"


class NameOrigin(str, Enum):
    EXPLICIT_USER = "explicit_user"
    HARNESS_AUTO = "harness_auto"
    UNKNOWN = "unknown"


class NameObservation(BaseModel):
    model_config = ConfigDict(frozen=True)

    title: str
    origin: NameOrigin
    source: str
    revision: str
    session_id: str | None
    sequence: int | None = None


class SourceCursor(BaseModel):
    revision: str
    sequence: int | None = None


class SessionNameState(BaseModel):
    model_config = ConfigDict(frozen=True)

    phase: NamePhase = NamePhase.UNNAMED
    title: str | None = None
    revision: int = 0
    session_id: str | None = None
    source: str | None = None
    fallback: str | None = None
    cursors: dict[str, SourceCursor] = Field(default_factory=dict)
    legacy_candidates: dict[str, str] = Field(default_factory=dict)

    @property
    def protected(self) -> bool:
        return self.phase in (NamePhase.USER_PINNED, NamePhase.PROTECTED_UNKNOWN)


def prompt_excerpt(prompt: str | None) -> str | None:
    """The immutable first-prompt backup, never provider-generated text."""
    text = " ".join((prompt or "").split())
    if not text:
        return None
    return text if len(text) <= 80 else text[:80] + "…"


def _advance(state: SessionNameState, **changes) -> SessionNameState:
    if all(getattr(state, key) == value for key, value in changes.items()):
        return state
    return state.model_copy(update={**changes, "revision": state.revision + 1})


def bind_name_state(state: SessionNameState, session_id: str | None) -> SessionNameState:
    """Reject old-session observations while retaining the last good title."""
    if state.session_id == session_id:
        return state
    return _advance(state, session_id=session_id, cursors={})


def consume_name_observation(state: SessionNameState, observation: NameObservation) -> SessionNameState:
    """Advance source evidence without adopting its title.

    User rename baselines use this to acknowledge provider records that already
    existed before the user's choice. A late watcher replay must not resurrect
    an earlier native manual rename.
    """
    if observation.session_id != state.session_id or not observation.title.strip():
        return state
    cursor = state.cursors.get(observation.source)
    if cursor is not None:
        if observation.revision == cursor.revision:
            return state
        if cursor.sequence is not None and observation.sequence is not None and observation.sequence <= cursor.sequence:
            return state
    return _advance(state, cursors={**state.cursors, observation.source: SourceCursor(
        revision=observation.revision, sequence=observation.sequence,
    )})


def reduce_name(
    state: SessionNameState,
    *,
    user_name: str | None = None,
    first_prompt: str | None = None,
    observation: NameObservation | None = None,
) -> SessionNameState:
    """Apply A user > B harness > C first prompt, without I/O or clocks."""
    if user_name is not None:
        if not user_name.strip():
            raise ValueError("A session name cannot be blank")
        # Explicit input retains its text, even executable/UUID-looking names.
        return _advance(state, title=user_name, phase=NamePhase.USER_PINNED, source="flowpad_user")

    excerpt = prompt_excerpt(first_prompt)
    if excerpt and not state.fallback:
        state = _advance(state, fallback=excerpt)
        if state.phase is NamePhase.UNNAMED:
            state = _advance(state, title=excerpt, phase=NamePhase.PROMPT_FALLBACK, source="first_prompt")

    if observation is None:
        return state
    consumed = consume_name_observation(state, observation)
    if consumed is state:
        return state
    state = consumed
    if state.protected and observation.origin is not NameOrigin.EXPLICIT_USER:
        return state
    phase = {
        NameOrigin.EXPLICIT_USER: NamePhase.USER_PINNED,
        NameOrigin.HARNESS_AUTO: NamePhase.HARNESS,
        NameOrigin.UNKNOWN: NamePhase.PROTECTED_UNKNOWN,
    }[observation.origin]
    return _advance(state, title=observation.title, phase=phase, source=observation.source)
