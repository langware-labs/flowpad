---
id: 6319f8e0-ad5f-489f-95f7-2ad8e9fe95f0
title: NULL sort order in the SQLite driver
tags:
- breadcrumb.test.null_sort_order.rules
description: A missing sort value buckets FIRST and is never compared against a real
  one — coercing it to "" raises str-vs-datetime.
---

# NULL sort order in the SQLite driver

> Ground truth. Proven on 2026-08-04. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.null_sort_order.rules
sites:
  - rel_path: "tests/unit/test_get_children_ordering.py"
    line: 112
    note: "FAILING? read this tag's rules \u2014 missing sorts FIRST; never coerce it to \"\""
```

## Expected behavior

Ordering entities by a field some of them lack must not raise, and must put the
missing values where SQLite's `ORDER BY ... ASC` puts them: **first**.

## Internals

* `SQLiteDBDriver._sort_key` (`flow_sdk/db/drivers/sqlite/sqlite_driver.py:2109`)
  returns `(0, "")` for `None` and `(1, value)` otherwise. The leading bucket is
  the whole mechanism: two values of different types never reach a comparison
  because their buckets differ first.

* `_apply_sorting` (`sqlite_driver.py:1541`) is the Python fallback used when the
  sort field lives inside a JSON blob and SQL cannot order it.

* `_sort_children` (`sqlite_driver.py:2128`) delegates to the same sorter, so
  child ordering and the main query path share one set of NULL semantics. It
  adds only a stable `id` pre-sort, so exact-timestamp collisions come back in
  the same order on every run instead of following relationship-row order.

## Invariants

* Missing sorts **before** present, ascending. Changing this desynchronises the
  Python fallback from the SQL path for the same rows.

* No two values of different types are ever compared directly.

* One sorter. If you add a third ordering path, delegate to `_sort_key` rather
  than writing a fourth key.

## Failure modes

The on/off lever: replace `_sort_key` with the old
`getattr(e, f, "") or ""` and ordering by `created_date` raises
`TypeError: '<' not supported between instances of 'str' and 'datetime.datetime'`.
Put `_sort_key` back and it passes. That is the whole bug in one line.

Note the test does **not** go through `get_children`: the driver stamps
`created_date` on every save, so a persisted entity can never have it NULL. A
test that built one and asserted on its position would be asserting on
`datetime.now()`. The sort key is what carries the NULL semantics, so it is
tested directly.
