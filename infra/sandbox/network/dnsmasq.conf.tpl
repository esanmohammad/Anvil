# dnsmasq configuration for anvil sandbox bridge.
#
# Rendered at runtime by `dnsmasqConfigBody(policy)` in
# `packages/dashboard/server/sandbox/network-policy.ts`. The fields
# below are the canonical defaults — see also §H.3 of
# `docs/sandbox-isolation-plan.md`.

no-resolv
no-hosts
log-facility=-
# Upstream resolver — only consulted for allow-listed names.
server=8.8.8.8

# {{allowList}} — a `server=/HOST/UPSTREAM` line per allow-listed host.
# {{blockList}} — an `address=/HOST/0.0.0.0` line per explicit block.
# When `default: deny`, the sinkhole `address=/#/0.0.0.0` line is
# appended so non-allow-listed names resolve to nowhere.
