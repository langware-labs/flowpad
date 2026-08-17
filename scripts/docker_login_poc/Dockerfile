FROM node:22-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq python3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm i -g @anthropic-ai/claude-code @openai/codex @github/copilot
ENV HOME=/root
