# Anvil sandbox base image — Mode 1 (Docker) runtime for the
# `build` / `test` / `validate` / `ship` / `fix` / `fix-loop` stages.
#
# Built + tagged via `infra/sandbox/build.sh`:
#
#   docker build -t anvil/sandbox:<core-pipeline-version> -f infra/sandbox/Dockerfile .
#   docker tag anvil/sandbox:<core-pipeline-version> anvil/sandbox:latest
#
# Kept intentionally small (~250 MiB compressed) — the image runs the
# user's project, not Anvil itself. Project deps install into the
# bind-mounted workdir at /workspace.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=development

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    busybox \
    ca-certificates \
    curl \
    dnsutils \
    git \
    gnupg \
    jq \
    less \
    openssh-client \
    procps \
    ripgrep \
    tini \
    tree \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Node.js 22 (LTS) — matches the package.json engines for Anvil itself.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Python 3 + pip — many Anvil-driven projects also need pytest etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Non-root user. Workdirs created by the runner mount over /workspace.
RUN useradd --create-home --shell /bin/bash --uid 1001 anvil \
  && mkdir -p /workspace \
  && chown -R anvil:anvil /workspace

WORKDIR /workspace
USER anvil

# `tini` is PID 1 so signals reach the user's process group cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "tail -f /dev/null"]
