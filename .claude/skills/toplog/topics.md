# Topic catalog

The living registry of toplog topics. Each topic names a trace stream that
`toplog.log([...], …)` calls in the code emit under. `run` reads this to pick the
right topics for an issue; `scan` diffs it against the code; `learn` maintains it.

The catalog starts empty on purpose — there are no production `toplog.log` calls
yet. Topics earn their place through `learn`, after a trace proves useful in an
RCA. That keeps the registry a record of *what actually helped*, not speculation.

## Registry

The registry is every `### <topic>` heading below. Add entries in this format:

```
### <topic>
- **Traces:** <what events / state transitions this stream logs>
- **Where:** <subsystem + a few representative file paths that emit it>
- **Use for:** <the symptom classes this topic illuminates>
```

<!-- New topics go here, one `### <topic>` heading each. Keep alphabetical so the
     registry stays scannable and catalog diffs stay stable across edits. -->

## Reconciliation rules (for `scan` and `learn`)

- **Source of truth is the pairing of code and catalog.** A topic is healthy when
  it is both referenced by at least one `toplog.log(...)` call *and* has a `###`
  entry here. `scripts/scan_topics.py` reports the two ways that breaks.
- **Undocumented** (in code, not catalogued): a `toplog.log` call uses a topic
  with no entry. Either add the entry (if the trace is worth keeping) or fold the
  call into an existing topic — decide in `learn`, never silently.
- **Stale** (catalogued, not in code): an entry whose trace lines are all gone.
  Confirm the code is really gone (not just renamed) before retiring the entry;
  retire entry and any leftover lines together so the pair stays consistent.
- **Enrich in place.** When a topic proves useful in a new area, extend its
  existing entry (more **Where**, sharper **Use for**) rather than appending a
  second entry for the same topic — one heading per topic keeps `scan` accurate.
