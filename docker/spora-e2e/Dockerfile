# Flowpad (this branch, docker/Dockerfile.flow-backend) + git access + a Docker CLI — nothing
# of Spora's. The end-to-end run proves a fresh machine goes from here to a working Spora
# through Flowpad alone: open the project from git, "Project setup required", the wizard,
# then the Spora Assistant installs and starts the rest.
ARG BASE=flowpad-backend:sdk-polish
FROM ${BASE}

# The Docker CLI only: the daemon is the host's, through the mounted socket — Spora's
# chat-service starts one sibling container per chat.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

# Git access = a token in the environment, handed to git on demand (never written to disk).
RUN git config --system credential.helper \
      '!f() { test "$1" = get && echo username=x-access-token && echo "password=${GITHUB_TOKEN}"; }; f'
