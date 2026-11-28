# Node from the pinned hub image (no curl|bash nodesource install).
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS node
FROM debian:13-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Core CLI, and Chromium (headless) with chromedriver
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gh \
    jq \
    ripgrep \
    fd-find \
    tmux \
    procps \
    chromium \
    chromium-driver \
    fonts-noto-color-emoji \
    fonts-liberation \
    python3 \
    python3-pip \
    python3-venv \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Node 22 LTS for the runner (matches hub and .nvmrc), copied from the pinned node image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# ZeroClaw (Apache-2.0), the agent engine: one static binary, pinned and checksummed
ARG ZEROCLAW_VERSION=v0.8.5
ARG ZEROCLAW_SHA256=e61e4e2944eccc0ab792ceec38cd290a469e661e24396224a9da84ad3447e4e8
RUN curl -fsSL -o /tmp/zc.tgz "https://github.com/zeroclaw-labs/zeroclaw/releases/download/${ZEROCLAW_VERSION}/zeroclaw-x86_64-unknown-linux-musl.tar.gz" \
  && echo "${ZEROCLAW_SHA256}  /tmp/zc.tgz" | sha256sum -c - \
  && tar -xzf /tmp/zc.tgz -C /usr/local/bin zeroclaw \
  && chmod 0755 /usr/local/bin/zeroclaw && rm /tmp/zc.tgz

# Create unprivileged agent user
RUN useradd -m -u 1000 -s /bin/bash agent \
  && install -d -m 0755 -o agent -g agent /home/agent /run/parly \
  && mkdir -p /etc/chromium.d \
  && printf 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic"\n' > /etc/chromium.d/parly-container

# Copy Vertex Gemini 4 agent runner and entrypoint
COPY parly-agent-runner.mjs /usr/local/bin/parly-agent-runner
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY parly-screenshot /usr/local/bin/parly-screenshot
COPY parly-upload.mjs /usr/local/bin/parly-upload
COPY parly-git-credential gh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/parly-agent-runner /usr/local/bin/entrypoint.sh /usr/local/bin/parly-screenshot /usr/local/bin/parly-upload /usr/local/bin/parly-git-credential /usr/local/bin/gh \
  && git config --system credential.https://github.com.helper /usr/local/bin/parly-git-credential

USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
