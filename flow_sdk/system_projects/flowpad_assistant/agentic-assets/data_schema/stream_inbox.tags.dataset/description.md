# stream_inbox.tags.dataset

One example per labelled Stream Inbox message: what the tag classifier reads (`input`, the message's
context) and the tag a person confirmed for it (`ground_truth.tag`, the full dot name; empty when no
tag fits). Rows come from applied classifications and from a person's later corrections; the row's key
is the message's id. A run of the classifier writes its own answer as `output`.
