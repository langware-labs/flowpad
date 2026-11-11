---
id: 082a91bf-87c7-5f07-a3bf-8d9bd4cef44f
---

# Project roles

A project role controls access inside Flowpad Cloud. It does not grant access to a GitHub repository.

Reader and Runner are independent. Select both when someone needs to inspect and run a project. Editor includes both capabilities plus editing.

| Role | Access |
| --- | --- |
| Reader | Inspect and read the project. Does not authorize running work or changing it. |
| Runner | Run authorized project operations. Does not authorize inspecting or editing the project. |
| Editor | Reader and Runner capabilities plus editing. |
| Admin | Editor capabilities plus administration and membership management. |
| Owner | Full ownership, including ownership transfer. |

`owner_by_api` is an internal credential role and cannot be granted through membership controls.

When sharing an asset, **Fix** selects Reader for a recipient who is not already a project member. You can select multiple roles before clicking Share. Leaving every role unselected sends the share without adding project membership. Existing memberships are unchanged.

Only owners and admins manage project membership. Owners may grant Admin, Editor, Reader, and Runner; admins may grant Editor, Reader, and Runner. The server validates every requested role. A failed membership lookup never means someone is a non-member, and pending invitations count as existing membership for this suggestion.
