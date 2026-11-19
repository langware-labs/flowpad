1Password — vault `{name}` ("{vault}" in 1Password):
- Any read or write makes the 1Password app ask the user to approve. Say so before you run it, and run one command at a time.
- It seals itself again a few minutes after the last approval, and whenever the app locks.
- "denied": the signed-in person is not a member of the vault. Only its owner can add them; tell the user.
- One item per variable, named `{item_prefix}<VARIABLE>`. Never create, edit or delete items with `op` yourself.
