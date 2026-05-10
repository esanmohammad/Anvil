#!/usr/bin/env bash
# Build + tag the Anvil sandbox image. The runner pins a version tag
# matching the running core-pipeline release; `:latest` is also tagged
# so a fresh checkout works without specifying a version.
#
# Usage:
#   infra/sandbox/build.sh                # tags both :<version> and :latest
#   infra/sandbox/build.sh --no-cache     # force a clean rebuild
#   ANVIL_SANDBOX_TAG=foo infra/sandbox/build.sh
#
set -euo pipefail

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${THIS_DIR}/../.." && pwd)"

VERSION="${ANVIL_SANDBOX_TAG:-}"
if [[ -z "${VERSION}" ]]; then
  if [[ -f "${REPO_ROOT}/packages/core-pipeline/package.json" ]]; then
    VERSION="$(node -e "console.log(require('${REPO_ROOT}/packages/core-pipeline/package.json').version)")"
  else
    VERSION="latest"
  fi
fi

EXTRA_ARGS=("$@")

echo "Building anvil/sandbox:${VERSION} (and :latest)"
docker build \
  -t "anvil/sandbox:${VERSION}" \
  -t "anvil/sandbox:latest" \
  -f "${THIS_DIR}/Dockerfile" \
  "${EXTRA_ARGS[@]}" \
  "${THIS_DIR}"

echo
echo "Done. Tags:"
docker images anvil/sandbox --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
