---
id: 28273c7c-a4d2-4010-901f-dc07ea86c8cc
title: Project roles
---

# Project roles

A project role controls access inside Flowpad Cloud. It does not grant access to a GitHub repository.

When you share assets from a linked project, a role selector appears for recipients confirmed not to be project members. Guest is selected by default. Existing members keep their current roles. Your choice is applied only when you click Share.

| Choice | Access |
| --- | --- |
| None | Share without adding project membership. Existing access is unchanged. |
| Guest | Limited to starting a guest conversation where supported. Cannot read, list, watch, or open the project. Sharing an asset does not change this project restriction. |
| Member | Read and open the project and view its members. Does not grant project editing or membership management. |
| Editor | Read and edit the project, use its project operations and manage memberships within the server's role-assignment limits. Includes access to project secrets. |
| Admin | Editor access plus project administration, deletion and access management. Public access remains the owner's decision. |

Owner has full control and is not offered by this sharing selector. Reader and public-view roles may exist through other access mechanisms; they are not choices in this project invitation flow.

The server checks your permission to invite and the role you may grant. A failed membership lookup is not treated as proof that a person is a non-member. Pending invitations also count as existing membership for this suggestion. An invitation may still require the recipient to accept it.

To let someone see the project, select **Member** or another role that includes project read access. **Guest does not provide that access.**
