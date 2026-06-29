# Stress-matrix harness image.
#
# Layered for cache-friendly rebuilds:
#   1. system + node + claude CLI + uv  (rarely changes)
#   2. flow_sdk python deps              (changes on dep bump)
#   3. flow_sdk source + harness scripts (changes often)

FROM python:3.10-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && pip install --no-cache-dir uv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/flowpad

COPY pyproject.toml ./
COPY flow_sdk ./flow_sdk

RUN uv pip install --system --no-cache .

# Harness scripts (runner_entrypoint.py + victimize.sh) are bind-mounted at
# runtime by the pytest harness — keeps the image stable while letting us
# iterate on cells without rebuilding. See tests/long_tests/stress_matrix/
# conftest.py::run_cell.

ENTRYPOINT ["/opt/victimize.sh"]
