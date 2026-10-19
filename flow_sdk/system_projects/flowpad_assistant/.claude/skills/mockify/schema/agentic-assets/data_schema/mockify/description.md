# mockify — journey mocks and the feedback on them

| kind | a value is |
|---|---|
| `mockify.mock` | one clickable mock: its journey (steps in order, with branches and open decisions), where it is served, and the session that builds it |
| `mockify.step` | one screen of a mock's journey |
| `mockify.decision` | one open question a screen asks the person reviewing it (D1, D2…) |
| `mockify.anchor` | where on a screen a comment applies: the element the reviewer pointed at (selector, label, HTML, position) |
| `mockify.feedback` | one comment a reviewer left on one screen of one mock: text, optionally an image, optionally the decision it answers |

Mocks live in the project's `mocks` dataset (row key = the mock's slug); feedback in `mock-feedback`
(row key = `<mock>-<step>-<n>`). Written only through the SDK / `dm_ctl` — by the mockify skill and
by the mock page itself.
