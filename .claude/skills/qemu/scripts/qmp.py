#!/usr/bin/env python3
"""Screen, keyboard and mouse for the VM, through QEMU's own sockets (input reaches only the VM).

  qmp.py status                 running / paused (io-error) / ...
  qmp.py shot OUT.png           screenshot (HMP screendump -> sips)
  qmp.py key meta_l-r           one HMP sendkey combo (ret, esc, tab, shift-tab, ctrl-alt-delete...)
  qmp.py type 'text'            types slowly (0.1 s/key; faster drops characters); \\n = Enter
  qmp.py click X Y [--right]    absolute click in screen pixels (needs the QMP socket)
  qmp.py wake                   wakes a black/sleeping display

VM_DIR (default ~/VMs/windows-11-arm) locates <name>-monitor.socket (HMP) and qmp.socket (QMP).
HMP `mouse_move` is relative and the guest's USB tablet ignores it — clicks go through QMP
`input-send-event` with absolute axes scaled to 0..32767.
"""
import json, os, re, socket, subprocess, sys, tempfile, time

VM_DIR = os.path.expanduser(os.environ.get("VM_DIR", "~/VMs/windows-11-arm")).rstrip("/")
NAME = os.path.basename(VM_DIR)
HMP = f"{VM_DIR}/{NAME}-monitor.socket"
QMP = f"{VM_DIR}/qmp.socket"

SHIFTED = {'!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
           '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right', '|': 'backslash',
           ':': 'semicolon', '"': 'apostrophe', '<': 'comma', '>': 'dot', '?': 'slash', '~': 'grave_accent'}
PLAIN = {' ': 'spc', '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right', '\\': 'backslash',
         ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'dot', '/': 'slash', '`': 'grave_accent',
         '\n': 'ret', '\t': 'tab'}


def hmp(cmd: str) -> str:
    s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(HMP)
    buf = b""
    while b"(qemu)" not in buf:
        buf += s.recv(4096)
    s.sendall(cmd.encode() + b"\n")
    buf = b""
    while buf.count(b"(qemu)") < 1:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    out = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", buf.decode(errors="replace")).replace("\r", "")
    lines = [l for l in out.split("\n")  # HMP echoes the command keystroke by keystroke on one line
             if l.strip() and not l.startswith("(qemu)") and not l.rstrip().endswith(cmd)]
    return "\n".join(lines)


def qmp(*cmds):
    if not os.path.exists(QMP):
        sys.exit(f"no QMP socket at {QMP}: add `-qmp unix:{NAME}/qmp.socket,server,nowait` to the conf's "
                 "extra_args and restart the VM")
    s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(QMP)
    f = s.makefile("rw")
    f.readline()  # greeting
    for c in ({"execute": "qmp_capabilities"},) + cmds:
        f.write(json.dumps(c) + "\n"); f.flush()
        while True:
            r = json.loads(f.readline())
            if "return" in r or "error" in r:
                if "error" in r:
                    sys.exit(f"QMP error: {r['error']}")
                break
    s.close()


def screen_size():
    with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as t:
        path = t.name
    hmp(f"screendump {path}")
    with open(path, "rb") as fh:
        head = fh.read(64).split()
    os.unlink(path)
    return int(head[1]), int(head[2])


def char_key(ch):
    if ch.isalpha():
        return f"shift-{ch.lower()}" if ch.isupper() else ch
    if ch.isdigit():
        return ch
    if ch in SHIFTED:
        return f"shift-{SHIFTED[ch]}"
    if ch in PLAIN:
        return PLAIN[ch]
    sys.exit(f"no key mapping for {ch!r}")


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "status":
        print(hmp("info status"))
    elif cmd == "shot":
        out = os.path.abspath(args[0])
        ppm = out.rsplit(".", 1)[0] + ".ppm"
        hmp(f"screendump {ppm}")
        subprocess.run(["sips", "-s", "format", "png", ppm, "--out", out], check=True, capture_output=True)
        os.unlink(ppm)
        print(out)
    elif cmd == "key":
        hmp(f"sendkey {args[0]}")
    elif cmd == "type":
        for ch in args[0].replace("\\n", "\n"):
            hmp(f"sendkey {char_key(ch)}")
            time.sleep(0.1)
    elif cmd in ("click", "wake"):
        w, h = screen_size()
        x, y = (int(args[0]), int(args[1])) if cmd == "click" else (w // 2, h // 2)
        btn = "right" if "--right" in args else "left"
        move = {"execute": "input-send-event", "arguments": {"events": [
            {"type": "abs", "data": {"axis": "x", "value": x * 32767 // w}},
            {"type": "abs", "data": {"axis": "y", "value": y * 32767 // h}}]}}
        cmds = [move]
        if cmd == "click":
            cmds += [{"execute": "input-send-event", "arguments": {"events": [
                {"type": "btn", "data": {"down": d, "button": btn}}]}} for d in (True, False)]
        qmp(*cmds)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
