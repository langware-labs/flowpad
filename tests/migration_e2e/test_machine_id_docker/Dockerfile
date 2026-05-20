# Tiny image for the machine_id cache-survival test.
#
# Installs flowpad from the locally-built wheel mounted at /wheels.
# The test script (in_container.sh) walks through M1-M8 exercising the
# cache-first contract under Linux.

FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    jq procps \
    && rm -rf /var/lib/apt/lists/*

# Null keyring backend keeps any incidental keychain access from hanging.
ENV KEYRING_PYTHON_KEYRING_BACKEND=keyring.backends.null.Null \
    HOME=/root \
    PYTHONUNBUFFERED=1

# python:3.10-slim doesn't ship /etc/machine-id (systemd writes it at
# first boot; slim images skip it). Synthesize a known-stable value so
# the test exercises the linux:/etc/machine-id derivation branch.
RUN echo "1234567890abcdef1234567890abcdef" > /etc/machine-id

WORKDIR /test
COPY in_container.sh /test/
RUN chmod +x /test/in_container.sh

ENTRYPOINT ["/test/in_container.sh"]
