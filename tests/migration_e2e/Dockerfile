# Docker image for the end-to-end migration test.
#
# Stays lean: python:3.10-slim + curl + jq. The wheel is built on the host
# (build_ui.py needs node/npm) and mounted at /wheels.
#
# Container runs as the **dev** instance on **port 9711** — chosen to be
# completely outside the standard prod (9007) / dev (9008) / test (9009)
# range so it never collides with anything the user has running locally.
#
# Instance selection:
#   - OLD 0.2.25 reads ``FLOWPAD_DEV=true`` (its only mode-selection knob)
#     → picks DevInstanceSettings → writes legacy ``dev_*`` paths.
#   - NEW 0.2.26 reads ``FLOW_INSTANCE=dev`` (the new canonical env var,
#     which wins over FLOWPAD_DEV in the resolver).
#   - Both versions honor ``LOCAL_SERVER_PORT=9711`` for the bind port.
# The container exposes 9711; host maps to 9711 (1:1, no remap).

FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq procps \
    && rm -rf /var/lib/apt/lists/*

ENV FLOWPAD_NO_BROWSER=1 \
    KEYRING_PYTHON_KEYRING_BACKEND=keyring.backends.null.Null \
    FLOWPAD_DEV=true \
    FLOW_INSTANCE=dev \
    LOCAL_SERVER_PORT=9711 \
    HOME=/root \
    PYTHONUNBUFFERED=1

EXPOSE 9711

WORKDIR /test
COPY in_container.sh seed_assets.py verify_post_migration.sh /test/
RUN chmod +x /test/in_container.sh /test/verify_post_migration.sh

ENTRYPOINT ["/test/in_container.sh"]
