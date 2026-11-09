"""A comment on a document, as the ``data`` of a ``Comment`` entity.

A doc's comments are one layer over the text — the markdown file is never written. Each
root comment is anchored to a quoted passage and has a kind:

* ``text`` — a person's note.
* ``questions`` — a ``MessageForm`` to answer in the doc; the answers land in ``answers``.
* ``change_request`` — "change this passage": the quote plus an instruction.

A reply is a ``Comment`` on the same doc whose ``data`` is ``{"reply": true, "reply_to":
"comment-<root id>"}`` — a child of the doc, not of its root, so it syncs to everyone the
doc is shared with exactly like the root does. An agent's reply also carries ``chat``, the
session turn it summarizes, so it links to the full message.

Everything after the root is a reply — the answers to a questions comment and every
status change too (``answers`` / ``status`` on a reply; the latest one wins). On a shared
doc only a comment's author may edit it, so append-only replies are what lets any
participant answer or mark a thread, the same way a message form's answers are a reply.
"""

from __future__ import annotations

from typing import ClassVar, Literal, Optional

from pydantic import model_validator

from flow_sdk.schema.data_spec.message_form_spec import FormAnswers, MessageForm, check_answers
from flow_sdk.schema.data_spec.spec import DataSpec

CommentKind = Literal["text", "questions", "change_request"]
CommentStatus = Literal["open", "sent", "done", "failed", "resolved"]


class DocAnchor(DataSpec):
    """Where a comment sits: the passage it quotes, and the source line it was made on
    (a hint — the quote is what is looked for when the text moves)."""

    spec_kind: ClassVar[str] = "doc.anchor"

    quote: str
    line: Optional[int] = None


class DocChangeRequest(DataSpec):
    """What should change in the quoted passage."""

    spec_kind: ClassVar[str] = "doc.change_request"

    instruction: str


class ChatLink(DataSpec):
    """The session message an agent's reply summarizes."""

    process_id: str
    at: str


class DocComment(DataSpec):
    """A root comment on a doc."""

    spec_kind: ClassVar[str] = "doc.comment"

    kind: CommentKind
    status: CommentStatus = "open"
    #: Who wrote it, as shown on the card: a person's name, or ``agent``.
    author: Optional[str] = None
    anchor: DocAnchor
    form: Optional[MessageForm] = None
    answers: Optional[FormAnswers] = None
    change: Optional[DocChangeRequest] = None

    @model_validator(mode="after")
    def _body_fits_kind(self) -> "DocComment":
        if self.kind == "questions":
            if self.form is None:
                raise ValueError("a questions comment needs a form")
            if self.answers is not None:
                _, problems = check_answers(self.form, dict(self.answers.values))
                if problems:
                    raise ValueError("answers: " + "; ".join(problems))
        if self.kind == "change_request" and self.change is None:
            raise ValueError("a change_request comment needs a change")
        return self


class DocCommentReply(DataSpec):
    """A reply in a doc comment's thread."""

    spec_kind: ClassVar[str] = "doc.comment_reply"

    reply: Literal[True] = True
    #: The thread's root comment, ``comment-<uuid>``.
    reply_to: str
    author: Optional[str] = None
    chat: Optional[ChatLink] = None
    #: The thread's answers from now on (a questions thread).
    answers: Optional[FormAnswers] = None
    #: The thread's status from now on.
    status: Optional[CommentStatus] = None
    #: Where the thread sits from now on — posted when the quoted passage was rewritten.
    anchor: Optional[DocAnchor] = None


def check_comment_data(data: dict) -> None:
    """Raise ``ValueError`` when ``data`` claims to be a doc comment (or reply) and does
    not fit. Legacy comment data (``{"line": N}``, task notes) passes untouched."""
    if "kind" in data:
        DocComment.model_validate(data)
    elif data.get("reply") is True:
        DocCommentReply.model_validate(data)
