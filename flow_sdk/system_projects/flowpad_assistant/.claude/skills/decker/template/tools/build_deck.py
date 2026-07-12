#!/usr/bin/env python3
"""build_deck.py — deterministic, stdlib-only Reveal.js deck assembler.

Assembles a deck of layout fragments into ONE self-contained HTML file with
zero external references (all CSS/JS/media inlined, media as base64 data URIs).
The output renders inside a sandboxed srcDoc iframe (sandbox="allow-scripts",
no same-origin, no base URL) — so Reveal is initialized headless with
hash:false / history:false (see common/deck.js).

Usage:
    python3 tools/build_deck.py <deck.json> -o <out.html>

deck.json shape:
    {
      "title": "My deck",
      "template": ".",                 // template root; default: tool's parent
      "slides": [
        { "layout": "cover-centered",
          "slots": { "title": "Hello", "subtitle": "World" } },
        { "layout": "metrics-grid",
          "slots": { "title": "Traction",
                     "items": [ {"metric-value": "12k",
                                 "metric-label": "users"} ] } },
        { "layout": "media-full-bleed",
          "slots": { "media": "media/common/placeholder.png",
                     "caption": "..." } }
      ]
    }

Slot values:
  - a string           -> escaped and inserted as text
  - {"html": "<b>x</b>"} -> inserted raw (no escaping)
  - "items": a list of dicts, one stamped copy of the layout's
    <template data-item> per dict (keyed by the item's inner data-slot names)
  - a media slot value is a path (relative to the template root) to an
    image/video; the file is base64-inlined as a data: URI.

Unfilled slots carrying `data-optional` are removed. Unfilled required slots
keep their placeholder so a raw layout still previews decently.

Exits non-zero with a clear message on: unknown layout, unknown slot name
(valid names are listed), or a missing media file.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
import sys
from html.parser import HTMLParser

VOID_TAGS = {"img", "hr", "br", "input", "source", "meta", "link", "col"}
IMAGE_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
VIDEO_EXT = {".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
             ".mov": "video/quicktime"}
MAX_MEDIA_BYTES = 2 * 1024 * 1024


def die(msg: str) -> "None":
    sys.stderr.write("build_deck: error: %s\n" % msg)
    sys.exit(1)


# --------------------------------------------------------------------------- #
# Lightweight HTML tree                                                        #
# --------------------------------------------------------------------------- #
class Node:
    __slots__ = ("tag", "attrs", "children", "void", "text", "raw")

    def __init__(self, tag=None, attrs=None, text=None, raw=None, void=False):
        self.tag = tag                  # element tag, or None for text/raw
        self.attrs = attrs or []        # list of (name, value|None)
        self.children = []
        self.void = void
        self.text = text                # verbatim data (text / style / script)
        self.raw = raw                  # pre-rendered raw HTML string

    def is_element(self):
        return self.tag is not None

    def attr(self, name):
        for k, v in self.attrs:
            if k == name:
                return v if v is not None else ""
        return None

    def has_attr(self, name):
        return any(k == name for k, _ in self.attrs)

    def drop_attr(self, name):
        self.attrs = [(k, v) for k, v in self.attrs if k != name]

    def clone(self):
        n = Node(self.tag, list(self.attrs), self.text, self.raw, self.void)
        n.children = [c.clone() for c in self.children]
        return n

    def serialize(self):
        out = []
        self._ser(out)
        return "".join(out)

    def _ser(self, out):
        if self.raw is not None:
            out.append(self.raw)
            return
        if self.tag is None:
            out.append(self.text or "")
            return
        out.append("<" + self.tag)
        for k, v in self.attrs:
            if v is None:
                out.append(" " + k)
            else:
                out.append(' %s="%s"' % (k, v))
        if self.void:
            out.append(" />")
            return
        out.append(">")
        for c in self.children:
            c._ser(out)
        out.append("</" + self.tag + ">")


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.root = Node(tag="#root")
        self.stack = [self.root]

    def _append(self, node):
        self.stack[-1].children.append(node)

    def handle_starttag(self, tag, attrs):
        node = Node(tag=tag, attrs=attrs)
        if tag in VOID_TAGS:
            node.void = True
            self._append(node)
        else:
            self._append(node)
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = Node(tag=tag, attrs=attrs, void=True)
        self._append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self._append(Node(text=data))

    def handle_entityref(self, name):
        self._append(Node(text="&%s;" % name))

    def handle_charref(self, name):
        self._append(Node(text="&#%s;" % name))

    def handle_comment(self, data):
        self._append(Node(raw="<!--%s-->" % data))


def parse_fragment(src):
    b = _TreeBuilder()
    b.feed(src)
    b.close()
    # first element child of root is the <section>
    for c in b.root.children:
        if c.is_element():
            return c
    die("layout fragment has no root element")


# --------------------------------------------------------------------------- #
# Slot filling                                                                 #
# --------------------------------------------------------------------------- #
def collect_slot_names(node, acc):
    if node.is_element():
        s = node.attr("data-slot")
        if s:
            acc.add(s)
        for c in node.children:
            collect_slot_names(c, acc)


def render_value(val):
    """Return a raw-HTML Node for a scalar slot value."""
    if isinstance(val, dict) and "html" in val:
        return Node(raw=str(val["html"]))
    return Node(raw=html.escape(str(val), quote=False))


def set_inner(node, value_node):
    node.children = [value_node]


def find_template(container):
    for c in container.children:
        if c.is_element() and c.tag == "template" and c.has_attr("data-item"):
            return c
    return None


def fill_simple_slot(node, val):
    set_inner(node, render_value(val))
    node.drop_attr("data-optional")


def fill_media(figure, media_path, template_dir):
    if not figure.has_attr("data-media-kind"):
        figure.attrs.append(("data-media-kind", figure.attr("data-media-kind") or "image"))
    ext = os.path.splitext(media_path)[1].lower()
    if ext in IMAGE_EXT:
        mime, is_video = IMAGE_EXT[ext], False
    elif ext in VIDEO_EXT:
        mime, is_video = VIDEO_EXT[ext], True
    else:
        die("unsupported media extension %r (%s)" % (ext, media_path))
    abspath = os.path.join(template_dir, media_path)
    if not os.path.isfile(abspath):
        die("media file not found: %s" % abspath)
    data = open(abspath, "rb").read()
    if len(data) > MAX_MEDIA_BYTES:
        sys.stderr.write(
            "build_deck: warning: media %s is %.1f MB (> 2 MB)\n"
            % (media_path, len(data) / 1048576.0))
    uri = "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))
    if is_video:
        raw = '<video controls src="%s"></video>' % uri
    else:
        raw = '<img src="%s" alt="" />' % uri
    figure.children = [Node(raw=raw)]
    figure.drop_attr("data-optional")


def fill_items(container, items, template_dir, valid_slots):
    tpl = find_template(container)
    if tpl is None:
        die("items container has no <template data-item>")
    item_markup = [c for c in tpl.children if c.is_element()]
    if items is None:
        # unfilled: drop the template, keep static preview children
        container.children = [c for c in container.children if c is not tpl]
        return
    stamped = []
    for item in items:
        if not isinstance(item, dict):
            die("each 'items' entry must be an object")
        for key in item:
            if key not in valid_slots:
                die("unknown slot %r in item; valid slots: %s"
                    % (key, ", ".join(sorted(valid_slots))))
        for tmpl_node in item_markup:
            clone = tmpl_node.clone()
            fill_node(clone, item, template_dir, valid_slots)
            stamped.append(Node(text="\n"))
            stamped.append(clone)
    container.children = stamped


def fill_node(node, slots, template_dir, valid_slots):
    """Recursively fill a subtree's slots from `slots`."""
    new_children = []
    for child in node.children:
        if not child.is_element():
            new_children.append(child)
            continue
        slot = child.attr("data-slot")
        if slot == "items":
            fill_items(child, slots.get("items"), template_dir, valid_slots)
            new_children.append(child)
        elif slot == "media":
            media_val = slots.get("media")
            if media_val is None:
                if child.has_attr("data-optional"):
                    continue
                new_children.append(child)
            else:
                fill_media(child, str(media_val), template_dir)
                new_children.append(child)
        elif slot:
            if slot in slots:
                fill_simple_slot(child, slots[slot])
                new_children.append(child)
            elif child.has_attr("data-optional"):
                continue  # drop unfilled optional slot
            else:
                new_children.append(child)  # keep placeholder
        else:
            fill_node(child, slots, template_dir, valid_slots)
            new_children.append(child)
    node.children = new_children


def build_slide(layouts_dir, layout, slots, template_dir):
    path = os.path.join(layouts_dir, layout + ".html")
    if not os.path.isfile(path):
        available = sorted(
            os.path.splitext(f)[0] for f in os.listdir(layouts_dir)
            if f.endswith(".html"))
        die("unknown layout %r; available: %s" % (layout, ", ".join(available)))
    section = parse_fragment(open(path, encoding="utf-8").read())
    valid_slots = set()
    collect_slot_names(section, valid_slots)
    for key in slots:
        if key not in valid_slots:
            die("unknown slot %r for layout %r; valid slots: %s"
                % (key, layout, ", ".join(sorted(valid_slots))))
    fill_node(section, slots, template_dir, valid_slots)
    return section.serialize()


# --------------------------------------------------------------------------- #
# Assembly                                                                     #
# --------------------------------------------------------------------------- #
def read(*parts):
    return open(os.path.join(*parts), encoding="utf-8").read()


def assemble(deck, template_dir):
    layouts_dir = os.path.join(template_dir, "layouts")
    vendor = os.path.join(template_dir, "vendor", "reveal")
    common = os.path.join(template_dir, "common")

    slides = []
    for i, slide in enumerate(deck.get("slides", [])):
        layout = slide.get("layout")
        if not layout:
            die("slide %d has no 'layout'" % i)
        slides.append(build_slide(layouts_dir, layout,
                                  slide.get("slots", {}), template_dir))

    css = "\n".join([
        read(vendor, "reset.css"),
        read(vendor, "reveal.css"),
        read(common, "tokens.css"),
        read(common, "theme.css"),
    ])
    js = "\n".join([read(vendor, "reveal.js"), read(common, "deck.js")])
    title = html.escape(str(deck.get("title", "Deck")), quote=False)

    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8" />\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
        "<title>" + title + "</title>\n"
        "<style>\n" + css + "\n</style>\n"
        "</head>\n<body>\n"
        '<div class="reveal">\n<div class="slides">\n'
        + "\n".join(slides) +
        "\n</div>\n</div>\n"
        "<script>\n" + js + "\n</script>\n"
        "</body>\n</html>\n"
    )


def main(argv=None):
    ap = argparse.ArgumentParser(description="Assemble a self-contained Reveal.js deck.")
    ap.add_argument("deck", help="path to deck.json")
    ap.add_argument("-o", "--out", required=True, help="output HTML path")
    args = ap.parse_args(argv)

    try:
        deck = json.load(open(args.deck, encoding="utf-8"))
    except (OSError, ValueError) as e:
        die("cannot read deck.json: %s" % e)

    tool_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    template = deck.get("template", ".")
    if template in (".", "", None):
        template_dir = tool_root
    elif os.path.isabs(template):
        template_dir = template
    else:
        template_dir = os.path.normpath(
            os.path.join(os.path.dirname(os.path.abspath(args.deck)), template))
    if not os.path.isdir(os.path.join(template_dir, "layouts")):
        template_dir = tool_root  # fall back to the tool's own template

    html_out = assemble(deck, template_dir)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html_out)
    sys.stderr.write("build_deck: wrote %s (%d slides)\n"
                     % (args.out, len(deck.get("slides", []))))


if __name__ == "__main__":
    main()
