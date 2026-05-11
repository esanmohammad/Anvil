#!/bin/sh
# Anvil sandbox overlay init — Phase P1.
#
# When the dashboard runner starts a container with the triple
#   /workspace.lower (RO bind of host workdir)
#   /workspace.upper (RW bind of host-side tmpdir)
#   /workspace.work  (RW bind of host-side tmpdir)
# this script mounts fuse-overlayfs to combine them at /workspace.
#
# When the triple isn't present (legacy bind-mode runners), the script
# is a no-op and the container falls through to its CMD with
# /workspace bind-mounted directly.
#
# fuse-overlayfs runs in user-space and doesn't need CAP_SYS_ADMIN.
# Docker only needs `--device /dev/fuse` and `--security-opt apparmor=unconfined`
# on hosts that ship AppArmor restrictions for fuse.
set -e

if [ -d /workspace.lower ] && [ -d /workspace.upper ] && [ -d /workspace.work ]; then
  if [ ! -d /workspace ]; then
    mkdir -p /workspace
  fi
  if ! mountpoint -q /workspace 2>/dev/null; then
    if command -v fuse-overlayfs >/dev/null 2>&1; then
      fuse-overlayfs \
        -o "lowerdir=/workspace.lower,upperdir=/workspace.upper,workdir=/workspace.work" \
        /workspace || {
          echo "anvil-init-overlay: fuse-overlayfs mount failed; continuing with lower bind-mount" >&2
          # Fall back: bind-mount the lower into /workspace (read-only).
          # The runner can still proceed; sync will detect no upper.
          mount --bind /workspace.lower /workspace 2>/dev/null || true
        }
    else
      echo "anvil-init-overlay: fuse-overlayfs binary missing" >&2
    fi
  fi
fi

# Chain to the original CMD.
exec "$@"
