import base64
from email import policy
from email.parser import BytesParser

import pytest

from flow_sdk.sources.gmail_send import InlineImage, compose_message, raw_message, send_message


def test_send_only_message_preserves_alternatives_recipients_and_cid():
    msg = compose_message(sender="sender@example.test", to=["one@example.test", "two@example.test"],
        cc=["cc@example.test"], subject="Weekly café", text="Plain report", html='<img src="cid:score">',
        inline_images=[InlineImage("score", b"image bytes", "score.png")])
    parsed = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw_message(msg)["raw"]))
    assert str(parsed["To"]) == "one@example.test, two@example.test"
    assert str(parsed["Cc"]) == "cc@example.test"
    assert str(parsed["Subject"]) == "Weekly café"
    assert parsed.get_body(preferencelist=("plain",)).get_content().strip() == "Plain report"
    assert 'src="cid:score"' in parsed.get_body(preferencelist=("html",)).get_content()
    image = next(part for part in parsed.walk() if part.get_content_type() == "image/png")
    assert image["Content-ID"] == "<score>" and image.get_payload(decode=True) == b"image bytes"


def test_unreferenced_inline_image_is_rejected():
    with pytest.raises(ValueError, match="referenced"):
        compose_message(sender="s@example.test", to=["r@example.test"], subject="Report", text="Text", html="HTML",
            inline_images=[InlineImage("missing", b"png", "image.png")])


async def test_confirmation_is_required_before_network():
    msg = compose_message(sender="s@example.test", to=["r@example.test"], subject="Report", text="Text", html="HTML")
    with pytest.raises(PermissionError, match="confirmation"):
        await send_message("", msg)
    with pytest.raises(ValueError, match="access token"):
        await send_message("", msg, approved=True)
