# Type icons

Files here are served at `/icons/<name>` and are addressable from any
`TypeInfo.icon` as a **path** instead of a lucide export name:

```python
icon="icons/my_type.svg"     # a file, served from this directory
icon="BrainCog"              # a lucide export name
```

The frontend discriminates on the slash — a lucide export name can never
contain one — and absolutises the path against the backend origin
(`ts_sdk/src/utils/icon-asset.ts`). Both shapes resolve through the same
`iconForType()` lookup, so a file-backed icon reaches every surface (rail,
tabs, breadcrumb, navigator, graph nodes) with no call-site changes. A file
that 404s falls back to the same generic document glyph an unknown lucide name
does.

**Prefer a lucide name.** It inherits `currentColor`, scales with the
surrounding text, and costs no request. Reach for a file only when the glyph
genuinely isn't in lucide — a vendor mark, a bespoke brand asset.

**Not `server/static/`** — `build_ui.py` wipes that directory wholesale on
every build, so a checked-in icon would survive only until the next packaging
run. This directory ships in the wheel via its own `package-data` entry.

**Licensing:** anything added here is redistributed in the wheel. Only commit
assets we own or that carry a license permitting redistribution without
attribution in the UI itself.

<!-- flowpad:capsule identity
version: 1
data:
  id: 0c4affe0-acb6-4b2e-9e0f-2e447455f8cd
flowpad:endcapsule identity -->
