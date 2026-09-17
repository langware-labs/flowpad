"""The ``gmail`` source's case in the data source matrix, and the ``Double`` behind it: the fake
mailbox served over real loopback IMAP and SMTP sockets, so a source in this process or a backend on
another port reads and sends through the same wire the driver speaks to Google."""
from __future__ import annotations

import base64
import socketserver
import threading
from contextlib import contextmanager
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, make_msgid
from typing import Optional

from pydantic import SecretStr

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources.credentials import AuthShape, Credentials

from .test_gmail_source import ADDRESS, ALL_MAIL, PASSWORD, _Gmail, _Imap, _Smtp

message_body = asset_module("gmail").message_body

CRLF = b"\r\n"


# ── the IMAP wire over the in-process mailbox ───────────────────────────────


def _tokens(line: str) -> list[str]:
    """IMAP atoms and quoted strings, unquoted; parentheses and brackets ride along in their atom."""
    out, i, n = [], 0, len(line)
    while i < n:
        if line[i] == " ":
            i += 1
        elif line[i] == '"':
            i, buf = i + 1, []
            while i < n and line[i] != '"':
                if line[i] == "\\" and i + 1 < n:
                    i += 1
                buf.append(line[i])
                i += 1
            out.append("".join(buf))
            i += 1
        else:
            j = i
            while j < n and line[j] != " ":
                j += 1
            out.append(line[i:j])
            i = j
    return out


class _ImapHandler(socketserver.StreamRequestHandler):
    """One IMAP session: exactly the commands ``gmail/source.py`` issues, answered from ``_Imap``."""

    def handle(self) -> None:
        state: _Imap = _Imap(self.server.mailbox)  # type: ignore[attr-defined]
        self._send(b"* OK Gimap ready" + CRLF)
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.rstrip(b"\r\n").decode("utf-8", "replace")
            tag, _, rest = line.partition(" ")
            command, _, args = rest.partition(" ")
            command = command.upper()
            with self.server.lock:  # type: ignore[attr-defined]
                if command == "CAPABILITY":
                    self._send(b"* CAPABILITY IMAP4rev1 X-GM-EXT-1" + CRLF)
                    self._ok(tag, "CAPABILITY")
                elif command == "LOGIN":
                    user, password = (_tokens(args) + ["", ""])[:2]
                    try:
                        state.login(user, password)
                    except Exception as exc:  # noqa: BLE001 — the fake's refusal, on the wire
                        self._send(f"{tag} NO {exc}".encode() + CRLF)
                    else:
                        self._ok(tag, "LOGIN")
                elif command in ("SELECT", "EXAMINE"):
                    status, data = state.select(args, readonly=command == "EXAMINE")
                    if status != "OK":
                        self._send(f"{tag} BAD {data[0].decode()}".encode() + CRLF)
                        continue
                    count = len(state.g.boxes[state.box])
                    self._send(f"* {count} EXISTS".encode() + CRLF)
                    self._send(f"* OK [UIDVALIDITY {state.g.validity}] UIDs valid".encode() + CRLF)
                    self._send(f"{tag} OK [READ-ONLY] {command} completed".encode() + CRLF)
                elif command == "UID":
                    sub, _, tail = args.partition(" ")
                    if sub.upper() == "SEARCH":
                        criteria = _tokens(tail)
                        if criteria and criteria[0].upper() == "UID":
                            criteria = [" ".join(criteria[:2]), *criteria[2:]]
                        _, data = state.uid("SEARCH", None, *criteria)
                        self._send(b"* SEARCH " + data[0] + CRLF)
                        self._ok(tag, "SEARCH")
                    elif sub.upper() == "FETCH":
                        uid_set, _, query = tail.partition(" ")
                        _, parts = state.uid("FETCH", uid_set, query)
                        for meta, body in parts:
                            # The fake answers as imaplib hands a literal back; the wire form is
                            # `* n FETCH (... item {size}` + the literal + `)`.
                            number, _, items = meta.partition(b" (")
                            items = items.replace(b" BODY {", f" {_item(query)} {{".encode())
                            self._send(b"* " + number + b" FETCH (" + items + CRLF + body + b")" + CRLF)
                        self._ok(tag, "FETCH")
                    else:
                        self._send(f"{tag} BAD unsupported UID {sub}".encode() + CRLF)
                elif command == "NOOP":
                    self._ok(tag, "NOOP")
                elif command == "LOGOUT":
                    state.logout()
                    self._send(b"* BYE" + CRLF)
                    self._ok(tag, "LOGOUT")
                    return
                else:
                    self._send(f"{tag} BAD unsupported {command}".encode() + CRLF)

    def _ok(self, tag: str, command: str) -> None:
        self._send(f"{tag} OK {command} completed".encode() + CRLF)

    def _send(self, data: bytes) -> None:
        self.wfile.write(data)
        self.wfile.flush()


def _item(query: str) -> str:
    """The data item a FETCH answer names: ``RFC822`` or the ``BODY[...]`` section asked for."""
    inner = query.strip("()")
    return "RFC822" if "RFC822" in inner else "BODY" + inner[inner.index("["):] if "[" in inner else "BODY"


# ── the SMTP wire over the same mailbox ─────────────────────────────────────


class _SmtpHandler(socketserver.StreamRequestHandler):
    """One SMTP session: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT; a message files as sent."""

    def handle(self) -> None:
        state = _Smtp(self.server.mailbox)  # type: ignore[attr-defined]
        self._send("220 gmail double ready")
        authed = False
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.rstrip(b"\r\n").decode("utf-8", "replace")
            verb, _, args = line.partition(" ")
            verb = verb.upper()
            if verb in ("EHLO", "HELO"):
                self._send("250-localhost", "250 AUTH PLAIN LOGIN")
            elif verb == "AUTH":
                mechanism, _, initial = args.partition(" ")
                authed = self._auth(state, mechanism.upper(), initial)
            elif verb == "MAIL":
                self._send("250 OK" if authed else "530 Authentication required")
            elif verb == "RCPT":
                self._send("250 OK")
            elif verb == "DATA":
                self._send("354 End data with <CR><LF>.<CR><LF>")
                lines = []
                while True:
                    chunk = self.rfile.readline()
                    if not chunk or chunk == b"." + CRLF:
                        break
                    lines.append(chunk[1:] if chunk.startswith(b"..") else chunk)
                message = BytesParser(policy=policy.default).parsebytes(b"".join(lines))
                with self.server.lock:  # type: ignore[attr-defined]
                    state.send_message(message)
                self._send("250 OK queued")
            elif verb == "QUIT":
                self._send("221 Bye")
                return
            elif verb in ("NOOP", "RSET"):
                self._send("250 OK")
            else:
                self._send("502 command not implemented")

    def _auth(self, state: _Smtp, mechanism: str, initial: str) -> bool:
        if mechanism == "PLAIN":
            if not initial:
                self._send("334 ")
                initial = self.rfile.readline().strip().decode()
            _, user, password = base64.b64decode(initial).decode().split("\0")
        elif mechanism == "LOGIN":
            self._send("334 VXNlcm5hbWU6")
            user = base64.b64decode(self.rfile.readline().strip()).decode()
            self._send("334 UGFzc3dvcmQ6")
            password = base64.b64decode(self.rfile.readline().strip()).decode()
        else:
            self._send("504 mechanism not supported")
            return False
        try:
            state.login(user, password)
        except Exception:  # noqa: BLE001 — the fake's refusal, on the wire
            self._send("535 Authentication failed")
            return False
        self._send("235 Authentication successful")
        return True

    def _send(self, *lines: str) -> None:
        self.wfile.write(CRLF.join(line.encode() for line in lines) + CRLF)
        self.wfile.flush()


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, handler, mailbox: _Gmail, lock: threading.Lock):
        super().__init__(("127.0.0.1", 0), handler)
        self.mailbox, self.lock = mailbox, lock


# ── the double ──────────────────────────────────────────────────────────────


class Double:
    """gmail as a test double: a loopback IMAP and SMTP server over one fake mailbox, an inbound
    you can inject, the outbound it saw."""

    provider = "gmail"

    #: The stranger who writes in.
    sender = "alice@example.com"

    def __init__(self):
        self.mailbox = _Gmail()
        self.lock = threading.Lock()
        self.config: dict = {}
        self.fields = {"account_key": ADDRESS}
        self.secrets = {"GMAIL_ADDRESS": ADDRESS, "GMAIL_APP_PASSWORD": PASSWORD}
        self._servers: list[_Server] = []

    def __enter__(self) -> "Double":
        imap = _Server(_ImapHandler, self.mailbox, self.lock)
        smtp = _Server(_SmtpHandler, self.mailbox, self.lock)
        self._servers = [imap, smtp]
        for server in self._servers:
            threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        self.config = {
            "address": ADDRESS,
            "imap_host": f"imap://127.0.0.1:{imap.server_address[1]}",
            "smtp_host": f"smtp://127.0.0.1:{smtp.server_address[1]}",
        }
        return self

    def __exit__(self, *_exc) -> None:
        for server in self._servers:
            server.shutdown()
            server.server_close()
        self._servers = []

    async def credentials(self, _row) -> Credentials:
        return Credentials(shape=AuthShape.ENV, values={k: SecretStr(v) for k, v in self.secrets.items()})

    def deliver(self, text: str, *, sender: str, thread: Optional[str] = None) -> dict:
        """An inbound message arriving now, in INBOX and All Mail. ``thread`` is the Message-ID it
        answers (its Gmail thread continues) or a Gmail thread id; None starts a thread."""
        message = EmailMessage(policy=policy.default)
        message["From"], message["To"], message["Subject"] = sender, ADDRESS.lower(), f"From {sender}"
        message["Date"] = formatdate(usegmt=True)
        message["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[-1] if "@" in sender else None)
        with self.lock:
            thrid = self._thread_of(thread)
            if thread and thread.startswith("<"):
                message["In-Reply-To"], message["References"] = thread, thread
            message.set_content(text)
            self.mailbox.deliver(message.as_bytes(), thrid)
        return {"external_id": str(message["Message-ID"]), "thread": thrid}

    def _thread_of(self, thread: Optional[str]) -> str:
        if thread and thread.startswith("<"):
            parent = next((t for _, t, r in self.mailbox.boxes[ALL_MAIL] if f"Message-ID: {thread}".encode() in r), None)
            if parent:
                return parent
        elif thread and thread.isdigit():
            return thread
        return str(9000 + self.mailbox.next_uid)

    def sent(self) -> list[dict]:
        with self.lock:
            return [
                {
                    "to": str(m["To"]),
                    "text": message_body(m).strip(),
                    "thread": str(m["In-Reply-To"]) if m["In-Reply-To"] else None,
                    "external_id": str(m["Message-ID"]),
                }
                for m in self.mailbox.sent
            ]


@contextmanager
def case(monkeypatch, tmp_path):
    with Double() as double:
        for name, value in double.secrets.items():
            monkeypatch.setenv(name, value)
        double.deliver("The treasure is under the mast.", sender="sailor@example.com")
        yield {
            "config": double.config,
            "fields": double.fields,
            "min_items": 1,
            "send": {"to": "sailor@example.com", "text": "matrix send", "subject": "Matrix"},
            "double": double,
        }
