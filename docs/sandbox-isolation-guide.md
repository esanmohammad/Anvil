# Sandbox Isolation — User Guide

Anvil now runs `build` / `test` / `validate` / `ship` / `fix` /
`fix-loop` inside an isolated runtime so a poisoned tool call or a
runaway script can't reach the host. This guide walks through enabling
the surface, configuring runtimes, and troubleshooting common errors.

> **Status:** shipped through Phase S12. Tier 1 (`none`) is the legacy
> default for read-only stages; Tier 2 (`docker`) is the new default
> for execute stages; Tier 3 (`firecracker` / `gvisor`) is opt-in.

---

## Modes

| Mode | Stages (default) | Cost | Risk | Enabled by |
|---|---|---:|---|---|
| `none` | clarify / requirements / specs / plan / review / research | 0 | n/a | Always on |
| `docker` (container) | build / test / validate / ship / fix / fix-loop | ~50 MiB / sandbox + ~300 ms acquire | Low | Docker on PATH |
| `firecracker` (microVM) | opt-in | ~10 MiB / VM + ~150 ms acquire | Very low | Linux + KVM + `firecracker-containerd` |
| `gvisor` (user-space kernel) | opt-in | ~25 MiB / sandbox + ~300 ms acquire | Very low | Linux + `runsc` |

---

## Quick start (Docker — the default)

```sh
# Pre-warm the sandbox image (one-time):
anvil doctor --pull-sandbox

# Or build it from source:
infra/sandbox/build.sh
```

That's the full setup. The next pipeline run that hits `build` /
`test` / `validate` / `ship` will spin a container automatically.

To verify a sandbox is actually starting:

```sh
anvil sandbox-runtime stats   # docker stats for anvil-* containers
```

---

## Per-stage policy

The default per-stage policy lives in
`packages/core-pipeline/src/routing/sandbox-policy.ts:STAGE_SANDBOX_POLICY`:

| Stage | Mode | FS | Network | Memory | CPU | Timeout | PIDs |
|---|---|---|---|---:|---:|---:|---:|
| clarify | none | host | full | — | — | — | — |
| requirements | none | host | full | — | — | — | — |
| specs / tasks / plan | none | host | full | — | — | — | — |
| **build** | **container** | overlay | allow-list | 4 GiB | 2 cores | 1800 s | 1024 |
| test | container | overlay | allow-list | 4 GiB | 2 cores | 600 s | 1024 |
| validate | container | overlay | allow-list | 2 GiB | 1 core | 300 s | 512 |
| **ship** | **container** | overlay | git-only | 1 GiB | 1 core | 600 s | 256 |
| fix / fix-loop | container | overlay | allow-list | 4 GiB | 2 cores | 1200 s | 1024 |
| review / research | none | host | full | — | — | — | — |

**Network allow-list defaults** (every container-mode stage):

- `npmjs.org`, `registry.npmjs.org`, `*.npmjs.com` (npm/yarn/pnpm)
- `pypi.org`, `files.pythonhosted.org` (pip)
- `crates.io`, `static.crates.io` (cargo)
- `goproxy.io`, `proxy.golang.org`, `sum.golang.org` (Go)
- `github.com`, `*.github.com`, `*.githubusercontent.com` (git)
- `gitlab.com`, `*.gitlab.com` (gitlab)
- `localhost`, `127.0.0.1`, `::1` (loopback)

**Ship is git-only by design.** It mutates remote state via `gh pr
create` / `git push`, so giving it npm access is unnecessary and
expands the blast radius.

---

## Per-project overlay

Tighten or loosen the defaults in
`~/.anvil/projects/<slug>/pipeline-policy.overlay.json`:

```jsonc
{
  "sandbox": {
    "default": {
      "runtime": "docker",
      "limits": { "memoryMiB": 8192, "timeoutSeconds": 3600 }
    },
    "perStage": {
      "build": { "runtime": "firecracker", "fsMode": "overlay" },
      "ship": {
        "network": {
          "default": "deny",
          "allowList": ["github.com", "myorg.privatesite.com"]
        }
      }
    },
    "network": {
      "default": "deny",
      "allowList": ["*.docs.example.com", "*.internal.example.com"],
      "blockList": ["*.tracker.com"]
    },
    "limits": {
      "perRunWallSeconds": 7200,
      "perStageWallSeconds": 1800,
      "totalDiskMiB": 8192
    }
  }
}
```

The overlay layers on top of the per-stage table; explicit
fields win, missing fields inherit.

---

## Filesystem propagation

Three modes:

- **`bind`** — sandbox sees host workdir directly (zero sync, weakest
  isolation). Default for `validate` if you want lint errors visible
  in your IDE.
- **`overlay`** — sandbox sees host as read-only base; writes land in
  a private upper layer; sync at stage end propagates the diff.
  Default for write+exec stages.
- **`none`** — no isolation. Default for read-only stages.

**Conflict resolution** when a host file changes during the sandbox's
lifetime (your IDE saved while a build was running):
- Default: `host-wins` — the host's edit stays, the sandbox's edit
  lands at `<file>.anvil-conflict` for review.
- `ship` stage: `sandbox-wins` — assumes exclusive ownership.

---

## Runtime selection

### Docker (default)

Docker on PATH is detected automatically. Set `DOCKER_BIN=/path/to/docker`
to override.

### Firecracker (opt-in)

Linux + KVM + `firecracker-containerd` required. Then:

```sh
infra/sandbox/firecracker-image-build.sh   # build the rootfs
echo "defaultRuntime: firecracker" >> ~/.anvil/sandbox.yaml
```

Or per-stage in `pipeline-policy.overlay.json`:

```jsonc
{ "sandbox": { "perStage": { "build": { "runtime": "firecracker" } } } }
```

### gVisor (opt-in)

Linux + `runsc` required. Same opt-in shape:

```sh
echo "defaultRuntime: gvisor" >> ~/.anvil/sandbox.yaml
```

---

## CLI reference

```sh
# Pre-warm the docker image
anvil doctor --pull-sandbox

# Drop into an interactive sandbox shell for debugging
anvil sandbox-runtime shell                # default: validate stage
anvil sandbox-runtime shell build --image my/sandbox:dev

# Clean up dangling containers from a crashed run
anvil sandbox-runtime prune                # safely (refuses busy)
anvil sandbox-runtime prune --force        # also removes busy containers

# See currently running anvil-* containers
anvil sandbox-runtime stats
```

---

## Defenses (defense-in-depth)

The sandbox surface stacks on top of the existing browser/web tool
defenses:

1. **Per-stage allow-list** for network egress (default-deny).
2. **Read-only package-manager mounts** — sandbox sees the user's
   `.npm` / `.cargo` / etc. but cannot write back unless the project
   opts in.
3. **Resource caps** (`--memory`, `--cpus`, `--pids-limit`,
   `--storage-opt size=`) prevent runaway scripts from exhausting
   the host.
4. **Path-escape refusal** — `read`/`write`/`edit` reject
   `../` traversal and absolute paths landing outside the workdir.
5. **kill-by-limit detection** — exit 137 / OOM / fork EAGAIN /
   "No space left" stderr patterns are surfaced as
   `killedByLimit: oom | pid | disk | timeout` so the harness can
   render the specific kill kind.
6. **Durable replay** — every sandbox boundary crossing is recorded
   as a `ctx.effect()` so post-takeover replays the recorded result
   without re-executing the command. Replay determinism is
   bounded by `sandbox state hash` — if the workdir's content
   Merkle digest drifts, replay throws
   `SandboxDeterminismViolationError` instead of silently returning
   a stale result.

---

## Troubleshooting

**`docker run failed: image not found`** — run `anvil doctor
--pull-sandbox` (or `infra/sandbox/build.sh` to build locally).

**`hostWorkdir does not exist: ...`** — the project's workspace
directory was moved or deleted. Check `~/.anvil/projects/<slug>/project.yaml`.

**`firecracker is not registered`** — `firecracker-containerd` isn't
on PATH or `/dev/kvm` isn't readable. The runner-registry falls
back to Docker silently — check `anvil sandbox-runtime stats` to
verify Docker took over.

**`SandboxDeterminismViolationError`** — the workdir content
changed between the recorded run and the replay. Use the
dashboard's "Rerun from stage" button to start a fresh sandbox
instead of replaying.

**`killedByLimit: oom` after a build** — bump `memoryMiB` for the
stage in the overlay:
```jsonc
{ "sandbox": { "perStage": { "build": { "limits": { "memoryMiB": 8192 } } } } }
```

**Mac users — Docker Desktop required.** Linux's namespaces +
cgroups don't exist on macOS / Windows; Docker Desktop runs a
Linux VM under the hood. Sandboxing still works, just with the VM
overhead.

---

## Next steps

- Read the full design doc: `docs/sandbox-isolation-plan.md`.
- Inspect a run's sandbox events in the dashboard's
  **Run history → Durable execution log** with the `sandbox`
  filter chip.
- Watch live resource usage in the dashboard's **Sandboxes** panel
  (mounted under Run Detail).
