# A machine with NO agent harness on it.
#
# python:3.10-slim deliberately: no node, so none of claude / codex / copilot /
# opencode can be present, and nothing in the image can accidentally satisfy the
# resolution this test is trying to see fail. Same base as
# tests/migration_e2e/Dockerfile, for the same reason.
#
# The wheel is built on the host (`uv build`) and mounted at /wheels. UI assets
# are NOT needed here — nothing serves a page; the check imports flow_sdk and
# resolves a worker binary.
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    KEYRING_PYTHON_KEYRING_BACKEND=keyring.backends.null.Null \
    FLOWPAD_NO_BROWSER=1 \
    HOME=/root

WORKDIR /test
COPY no_harness_check.py /test/

# --mount keeps the wheel out of the image layers; --no-cache-dir keeps it small.
RUN --mount=type=bind,source=wheels,target=/wheels \
    pip install --no-cache-dir /wheels/*.whl

ENTRYPOINT ["python", "/test/no_harness_check.py"]
