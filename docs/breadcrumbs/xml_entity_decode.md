***

title: XML entity decode belongs to the XML transport, not to FlowData
tags:

* breadcrumb.test.xml\_entity\_decode.rules
  description: Only the XML stream escapes flow content, and only into & < >.
  The client decode must mirror that exact alphabet, because the same decode also
  runs on get-history, which escapes nothing — a wider decode rewrites transcript
  text nobody encoded, and a decoded quote breaks the JSON around it and drops the
  entire replay.
  version: 2

***

# XML entity decode belongs to the XML transport, not to FlowData

> Ground truth. Proven by RCA on 2026-08-30 (FLOWPAD-2038), toggled both
> directions on a live 1603-row transcript and in the running app. Do not edit
> without the user's approval.

```breadcrumb
tag: breadcrumb.test.xml_entity_decode.rules
sites:
  - rel_path: "ui/tests/unit/flow-data-html-entity-json.test.ts"
    line: 79
    note: "FAILING? read this tag's rules before editing — an empty replay is the bug, do not assert only that loadHistory resolved"
```

## Expected behavior

A transcript records what the agent actually wrote. If an agent writes the six
characters `&quot;` into a file, replaying that turn shows `&quot;` — six
characters, not a quote mark. Nothing the agent can type into a tool argument
may change how the rest of the conversation parses.

Concretely: `GET .../get-history` → `AgenticProcess.loadHistory` → the chat pane
renders **every** row. an empty pane over a non-empty transcript is a failure
of this contract, not a partial  success, and it is indistinguishable to the user
from a session that never happened.

## Internals

**Three producers feed** **`FlowData`, and only one of them escapes.**

| producer                                       | escapes? | client decodes? | <br />     |
| ---------------------------------------------- | -------- | --------------- | ---------- |
| XML stream — `element_xml` / `content`         | yes      | yes             | ✅ paired   |
| WebSocket — `ts_sdk/src/FlowSync/store.ts:488` | no       | no              | ✅ paired   |
| `get-history` — `agentic_process.py:6366`      | **no**   | **yes**         | ❌ unpaired |

*Encoder.* `_escape_xml_content` (`flow_sdk/core/flow/models/flow_data.py:33`,
byte-identical copy at `flow_sdk/external_apis/llm/llm_drivers/flow_data.py:31`)
is `html.escape(content, quote=False)` after stripping control characters. It
emits **exactly three** entities — `&amp;`, `&lt;`, `&gt;` — and **never**
`&quot;`: content, unlike an attribute value, does not terminate on a quote, and
a serialized JSON document must keep its structural `"`. Attributes take the
stricter `_escape_xml_attribute` (`quote=True`, plus `&#10;`/`&#13;`/`&#9;`), and
attributes are **not** run through the decoder at all — `parseAttributes` in
`ts_sdk/src/flow_processing/xml-utilities.ts` regex-extracts raw values.

For object/entity rows the encoder runs **after** `json.dumps`, over the finished
document. That forces the client's order: unescape the whole buffer, then parse.
Decode-then-parse is the correct inverse, not an accident.

*Decoder.* `decodeXMLEntities`
(`ts_sdk/src/flow_processing/xml-utilities.ts:121`, alphabet at `:93`) is called
from `parseElementData` (`flow-data.ts:265`) **before** the switch on
`data-type`, so it cannot know whether it holds a plain string or a JSON
document.

*Why* *`get-history`* *reaches the decoder at all.* `get_history_action` returns
`fd.model_dump(mode="python")` into a JSON body — no XML framing, no escaping.
`FlowData.fromJSON` (`flow-data.ts:591`) then stringifies a non-string
`flow_value` at `:601`, which **defeats the guard at** **`flow-data.ts:254`** — the
`typeof rawData === 'object'` early-return whose own comment says *"from
history/websocket"* and which returns before the decode line. The WebSocket path
passes the object through unstringified, lands in that branch, and is fine.
History stringifies, misses it, and gets decoded.

*The amplifier — why one bad row loses all of them.* `_setError` emits `ERROR` on
a `FlowData` with no error listener, so the emitter itself throws
`Unhandled error. (…)`. That rethrow escapes `parseElementData`'s own catch, then
the constructor, then aborts the `for` loop in `loadHistory`
(`agentic-process.ts:1956`), and is swallowed by its outer catch at `:2058`.
Nothing is appended. **28 malformed rows out of 1603 emptied the whole pane.**

*Surfacing.* `loadHistory` **resolves** on that path, so the UI's
`loadHistory().catch(...)` handlers can never see it. It emits `history-error`
(`agentic-process.ts:2075`) instead — deliberately **not** named `error`, which
is `EventEmitter`'s special-cased name and would throw again when unlistened,
reproducing the very amplification above. `useHistoryLoadAlert`
(`ui/src/hooks/use-history-load-alert.ts:27`) turns it into a `forceToast` alert,
mounted from `use-flow-data-trace.ts:57` (chat) and `use-process-surface.ts:88`
(vibe); `notify` dedupes on id, so both may mount.

## Invariants

1. **The decoder's alphabet must equal the encoder's.** Exactly `&amp;`, `&lt;`,
   `&gt;`. Widening it is never a bug fix — every extra spelling is an unpaired
   decode of text no producer encoded.
2. **Never decode** **`&quot;`,** **`&quot`,** **`&#34;`** **or** **`&#x22;`** **in content.** These are
   the four spellings that yield a *structural* quote. The encoder emits none of
   them; decoding any of them can break the JSON around it.
3. **Single pass.** `&amp;lt;` must decode to `&lt;`, never to `<`. Use one
   regex alternation, not chained `replace` calls.
4. **A parse failure must never be silent.** Whatever swallows it must also
   announce it. An empty pane with no alert is the bug, not the recovery.
5. **Assert on content, not on absence of a throw.** A green `loadHistory` that
   returned zero rows is the failure this tag exists for.

## Failure modes

**Decoding wider than the encoder emits.** The original implementation was
`textarea.innerHTML = text; return textarea.value` — the browser's full HTML
parser. It resolved the entire named-entity set plus numeric and
semicolon-less references: `&quot;` `&quot` `&#34;` `&#x22;` all → `"`, and
`&copy;` → . On the stream that was harmless (the encoder escapes `&`, so a
literal `&quot;` arrives as `&amp;quot;` and round-trips). On `get-history` it
rewrote raw transcript text, and a decoded quote closed a JSON string early:

```
{"args":{"content":"print(&quot;hi&quot;)"}}   →   {"args":{"content":"print("hi")"}}
SyntaxError: Expected ',' or '}' after property value in JSON at position 29
```

## Related

* [Served app HTML must be read as UTF-8](served_html_encoding.md) — same family:
  an encoding contract that a permissive default silently violates.

<!-- flowpad:capsule identity
version: 1
data:
  id: e81f1d9a-4848-4e78-90e8-5c90daf2cd14
flowpad:endcapsule identity -->
