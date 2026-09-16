# A machine with NEITHER git NOR a system python3 — the only container in which
# the dev-toolchain wizard's two steps genuinely have work to do.
#
# Flowpad is Python, so "no python" needs explaining: the backend runs on uv's
# own managed CPython under ~/.local/share/uv, exactly as the desktop app
# installs it (electron/uv-manager.js:675 `uv tool install flowpad --python
# 3.10`, which auto-downloads an interpreter when none is present). Inside
# Python every subprocess re-entry uses `sys.executable`, never the literal
# "python3" (flow_sdk/server/launch.py:210), so an absent system interpreter is
# genuinely fine.
#
# The two other container paths in this repo cannot be used here and that is
# not an oversight: install_flow_on_docker.sh hard-exits without python3, and
# docker/Dockerfile.flow-backend is FROM python:3.10-slim and apt-installs git.
#
# node:22-bookworm-slim carries node (for the Claude CLI, which needs no Python)
# and neither of the two binaries under test — verified: python3, python, git and
# even curl are all absent from it. The repo's own scripts/docker_login_poc
# Dockerfile uses the same base and has to `apt-get install python3`, which is
# the same fact from the other direction.
#
# It is nonetheless ASSERTED rather than assumed, three times below: a base image
# that quietly gains python or git turns this whole test into a green run that
# proves nothing, and that is the one failure mode worth failing the BUILD over.
# Overridable so the image can be built on a machine whose docker daemon cannot
# reach the registry (retag the base locally and pass --build-arg BASE_IMAGE=...).
# The assertions below are what actually guarantee the base is clean, so a
# substituted base is checked exactly as hard as the default one.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

# ── Assertion 1: the base image is clean ─────────────────────────────────────
# If this fires the whole test is meaningless, so fail the BUILD rather than
# discover it in a green run that proved nothing.
RUN if command -v python3 || command -v python || command -v git; then \
      echo "BASE IMAGE DIRTY: python or git is present — this test cannot prove anything"; \
      exit 1; \
    fi

# curl for the uv installer, ca-certificates for TLS. Neither pulls python or git.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

# ── Assertion 2: apt did not drag one in ─────────────────────────────────────
# This is where a transitive dependency would sneak python or git back, which
# is exactly why the check is repeated after the layer rather than only before.
RUN if command -v python3 || command -v python || command -v git; then \
      echo "APT LAYER LEAKED python or git — trim the package list"; \
      exit 1; \
    fi

# uv is a static binary: it bootstraps with no Python at all.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# The harness the capability-installer agent runs under. Node only.
RUN npm install -g @anthropic-ai/claude-code@2.1.197 && claude --version

# OUR working tree, not the PyPI release — the host driver builds the wheel and
# a COPY keeps the image self-describing (a bind mount would not).
COPY dist/flowpad-*.whl /wheels/
RUN uv tool install --python 3.10 --force /wheels/flowpad-*.whl \
 && flow --help > /dev/null
# `flow --help`, not `flow --version` — the CLI has no --version option and
# exits non-zero on one, which would fail the build for the wrong reason.
# Verified in the container: uv puts flowpad on its own managed CPython at
# ~/.local/share/uv/python/cpython-3.10.*, reachable only through the tool
# venv, never as `python3`.

# ── Assertion 3: installing flowpad did not put python on PATH ───────────────
# uv's managed interpreter lives under ~/.local/share/uv and is NOT exposed as
# `python3`. If it ever were, the wizard's first step would silently report
# "already satisfied" and the run would prove nothing.
RUN if command -v python3 || command -v git; then \
      echo "FLOWPAD INSTALL LEAKED python or git onto PATH"; \
      exit 1; \
    fi

# The backend and the `claude` CLI must agree on ONE `.claude`. Without this,
# `FLOW_INSTANCE=test` sandboxes claude_home to a per-invocation temp dir while
# the CLI writes to $HOME/.claude, so `get_claude_session(session_id)` never
# finds the transcript, `worker_status` stays null, and `AgenticProcess.wait()`
# — which returns only on a TERMINAL status — spins until its timeout. A step
# whose worker died in the first second then hangs for the whole budget.
# `FLOWPAD_CLAUDE_HOME` exists for exactly this (see test_settings.py).
ENV FLOWPAD_CLAUDE_HOME=/root/.claude

# The secret store, unlocked headlessly. `set_lm_api` writes the installer
# agent's provider key into it, and the BACKEND has to read the same store when
# it spawns a worker — so this belongs in the image environment rather than in
# the one shell that seeds it.
#
# It must be a real FERNET key (32 url-safe base64 bytes), not a memorable
# string: anything else fails the write with "Fernet key must be 32 url-safe
# base64-encoded bytes" — and that error is logged, not raised, so the seeding
# step happily reported success while nothing had been stored. Throwaway value
# for a throwaway container; it guards nothing that outlives the run.
ENV SOD_ENC_KEY=spQrMo85xjLmJcrhJXBh8j7el8f7ZDny3dUW2yKw7jU=

ENV PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring \
    FLOWPAD_NO_BROWSER=1 \
    IS_SANDBOX=1 \
    FLOW_INSTANCE=test \
    LOCAL_SERVER_PORT=9712 \
    PYTHONUNBUFFERED=1

# Staged into `dist/` by run.sh, NOT copied from `tests/` — a repo-local
# `.dockerignore` (untracked, so it varies per machine) commonly excludes
# `tests`, and an ignored path fails the build with "not found", which reads
# like a missing file rather than an ignored one. `dist/` already has to be in
# the context for the wheel above, so staging beside it makes the build depend
# on nothing but what run.sh put there.
COPY dist/in_container.sh /test/in_container.sh
RUN chmod +x /test/in_container.sh
ENTRYPOINT ["/test/in_container.sh"]
