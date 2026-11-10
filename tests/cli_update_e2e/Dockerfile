# A machine with every harness CLI one release behind (or more): what the
# background update check must flag. The versions are build args so a run can
# pin any other old release.
FROM python:3.11-slim

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends curl ca-certificates git \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null \
 && apt-get install -y -qq --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE=2.1.197
ARG CODEX=0.147.0
ARG COPILOT=1.0.100
ARG OPENCODE=1.18.2
RUN npm install -g -q @anthropic-ai/claude-code@${CLAUDE} @openai/codex@${CODEX} \
      @github/copilot@${COPILOT} opencode-ai@${OPENCODE} \
 && npm cache clean --force \
 && claude --version && codex --version && copilot --version && opencode --version

RUN pip install -q --no-cache-dir uv
WORKDIR /app
COPY pyproject.toml README.md ./
COPY flow_sdk ./flow_sdk
RUN uv pip install -q --system . 'fastmcp<4' 'mcp<2'

ENV PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring \
    LOCAL_SERVER_PORT=9050 FLOWPAD_SKIP_DOTENV=true
COPY dist/cli_update_check.py /check.py
ENTRYPOINT ["python", "/check.py"]
