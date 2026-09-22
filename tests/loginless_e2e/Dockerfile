# A foreign machine: nothing of ours on it but the flow_sdk wheel, and no login anywhere.
#
# The proof this image exists for is that TWO commands are enough (see run.sh):
#
#     flow llm user use <public-endpoint-id> --hub <hub>
#     python agentic_process_snippet.py
#
# so the image deliberately carries NO funding or identity: no hub key, no provider key, no
# FLOWPAD_HUB_URL, no SOD_ENC_KEY, no keyring backend override, no IS_SANDBOX. Anything that
# would have to be added here to make those two commands pass is a product gap, not a rig detail.
FROM node:22-bookworm-slim

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

# The one thing an agentic process cannot exist without: a harness CLI. All four, so the worker
# matrix (worker_matrix.py) can prove each of them; claude pinned for the same reason
# docker/Dockerfile.flow-backend pins it.
RUN npm install -g @anthropic-ai/claude-code@2.1.197 @openai/codex @github/copilot opencode-ai \
 && claude --version && codex --version && copilot --version && opencode --version

# Not root: claude refuses --dangerously-skip-permissions as root, and a real foreign machine
# is a person's account, not uid 0.
RUN useradd --create-home --shell /bin/bash flow
USER flow
WORKDIR /home/flow

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/flow/venv/bin:/home/flow/.local/bin:${PATH}"

# "flow_sdk installed": one pip install of the wheel built from this tree, into the venv whose
# `python` and `flow` are the two commands' interpreters.
COPY --chown=flow:flow dist/flowpad-*.whl /home/flow/wheels/
RUN uv venv --python 3.10 /home/flow/venv \
 && uv pip install --python /home/flow/venv/bin/python /home/flow/wheels/flowpad-*.whl \
 && flow --help > /dev/null

# Staged into dist/ by run.sh: .dockerignore keeps tests/ out of the build context.
COPY --chown=flow:flow dist/agentic_process_snippet.py dist/worker_matrix.py /home/flow/
