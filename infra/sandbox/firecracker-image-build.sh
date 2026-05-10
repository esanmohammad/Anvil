#!/usr/bin/env bash
# Convert the OCI sandbox image to a Firecracker rootfs.
#
# Usage:
#   infra/sandbox/firecracker-image-build.sh                 # default tag
#   ANVIL_SANDBOX_TAG=foo infra/sandbox/firecracker-image-build.sh
#
# Output: anvil/sandbox-firecracker:<tag> (a containerd image
# produced by `docker save | ctr import`).
#
set -euo pipefail

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${ANVIL_SANDBOX_TAG:-latest}"

echo "==> ensuring docker image anvil/sandbox:${TAG} exists"
"${THIS_DIR}/build.sh"

echo "==> exporting docker image to a tar"
DEST="${THIS_DIR}/.firecracker-rootfs.tar"
docker save "anvil/sandbox:${TAG}" -o "${DEST}"

echo "==> importing into firecracker-containerd"
sudo ctr --namespace firecracker images import "${DEST}"

echo "==> tagging as anvil/sandbox-firecracker:${TAG}"
sudo ctr --namespace firecracker images tag \
  "docker.io/library/anvil/sandbox:${TAG}" \
  "docker.io/library/anvil/sandbox-firecracker:${TAG}" || true

rm -f "${DEST}"

echo
echo "Done. Listing namespace images:"
sudo ctr --namespace firecracker images ls | head
