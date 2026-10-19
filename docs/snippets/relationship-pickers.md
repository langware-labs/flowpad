---
id: 90115f9a-be9f-4da7-9c0a-bf50a1571dbd
---
# Relationship pickers in SDK viewers

`ViewerHost.candidates` supplies relationship values; `ViewerHost.choices`
selects viewer modules. These are separate contracts. The SDK exports
`mountRelationshipPicker` for create forms and inline editors, with the same
provider available to nested viewers as `ViewerContext.candidates`.

The host supplies a function accepting `{kind, field, parent, selected, search,
cursor}` and returning `{items, next?}`. Each item is `{key, label, value}`:
`key` is stable selection identity, `label` is display text, and `value` is the
reference passed back to the host. `parent` is the form's current record snapshot;
the provider applies relationship rules, search and pagination. The picker does
not infer domain rules or build backend URLs. A backend-backed provider uses
Dataset actions or SDK `apiClient`.

```ts
const ctx = createViewerContext({ candidates: query => repository.candidates(query) });
const picker = mountRelationshipPicker(element, {
  kind: "crm.persona",
  field: "personas",
  parent: () => readForm(),
  multiple: true,
  selected: initialReferences, // [{key, label, value}]
  onChange: () => refreshDependentPickers(),
}, ctx);
await picker.refresh();
// Before saving through the existing Dataset writer:
picker.validate(); // refuses pending or failed candidate loads
const references = picker.read();
```

`read()` returns one reference or null, or an ordered array for `multiple`.
Selections survive search, pagination and parent changes; the user can remove
or reorder them. A parent change calls `refresh()`; a newer response takes
precedence over an older response. The host supplies `readonly: true` when
editing is not allowed. Existing selections remain visible in readonly mode.

This API changes controls, not persistence. Dataset still owns link validation,
field ownership and optimistic versions. Preserve the originally read version
when saving, and show Dataset's conflict/refusal to the user. Keeping a selected
reference after a parent change does not make it valid: Dataset must still check
the resulting record. No FlowCall invocation or new result envelope is needed.

Source tests: `ui/tests/unit/relationship-picker.test.ts` exercises the actual
control with local candidate providers. Dataset rule/owner/conflict tests remain
in `tests/unit/test_data_spec/test_row_rules.py` and
`test_schema_owned_unique_include.py`. Installed browser readiness is a separate
deployment check.
