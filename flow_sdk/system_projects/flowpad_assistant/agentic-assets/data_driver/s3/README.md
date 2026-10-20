# s3

Objects in an Amazon S3 bucket, or an S3-compatible store (`base_url`: MinIO, R2).

- **Listing** is `ListObjectsV2` under `prefix`: one authoritative enumeration per pass, like `gcs`.
- **Rows** (`RowFiles`): a dataset whose `dataset.json` says `"location": "s3:<bucket>/<prefix>"` keeps
  its row files under that prefix, one object per file (`<prefix>/rows/<key>/row.json`). Writes and
  deletes are conditional on the object's ETag (`If-Match`, or `If-None-Match: *` for a new file):
  S3 itself refuses a stale write, so two writers can never both land.
- **Credentials**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary keys,
  `AWS_SESSION_TOKEN` -- set with `flow credentials set`, or in the environment. Requests are signed
  with Signature Version 4 (`sigv4.py`), with no AWS SDK.
