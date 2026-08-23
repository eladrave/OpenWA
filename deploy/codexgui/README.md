# CodexGUI OpenWA monitoring deployment overlay

This directory contains service-specific deployment artifacts only. Shared host layout, central
Caddy ownership, edge topology, backup expectations, and cross-service mutation rules remain owned
by the current **CodexGUI Container Deployment Runbook** in the canonical Codex Google Drive folder.

Do not apply this overlay until live inspection confirms that the candidate service slug, Compose
project, edge alias, private port, public hostname, route, state directory, and systemd unit do not
conflict. Replace the example values only in root-owned host files; never commit them.

## Installed boundaries

```text
/opt/services/openwa-monitor/       compose.yaml and service-specific support files
/etc/openwa-monitor/runtime.env     stable runtime credentials and compatibility token, root:root 0600
/etc/openwa-monitor/deploy.env      immutable image and resolved host aliases, root:root 0600
/etc/openwa-monitor/postgres-ca.pem PostgreSQL server certificate trust anchor, root-owned
/var/lib/openwa-monitor/            main auth/audit SQLite and WhatsApp auth state, root:root 0700
/etc/systemd/system/openwa-monitor.service
```

The application publishes no host port, mounts no Docker socket, and joins only the external `edge`
network under one unique alias. The image entrypoint repairs `/app/data` ownership with a minimal
capability set, then drops to its unprivileged `openwa` user before Node or Chromium starts.

Session, message, and monitoring data use a dedicated database/role on the host's existing native
PostgreSQL 16 service through a certificate-matching hostname mapped to Docker's `host-gateway`.
OpenWA's separate auth/audit main connection remains a small local SQLite file by architecture. Do
not reuse another application's database identity when a dedicated role/database can be created on
the same server.

The live PostgreSQL certificate is self-signed for its own DNS name. Map that exact certificate
hostname to `host-gateway`, copy only the public certificate into `postgres-ca.pem`, set
`NODE_EXTRA_CA_CERTS`, and keep `DATABASE_SSL_REJECT_UNAUTHORIZED=true`. Do not disable certificate
verification merely to make the container connect.

## Permanent URL-token contract

Generate `MCP_STABLE_URL_TOKEN` once from at least 32 random bytes encoded with URL-safe base64. Store
it only in `runtime.env`; normal upgrades never replace that file. Create a separate OpenWA
`OPERATOR` key with an explicit allowlist containing exactly the pre-created monitoring session, and
store it as `MCP_STABLE_BACKEND_API_KEY`.

The application supports:

- ordinary `/mcp` with an API-key/bearer header for private administration;
- `/<stable-token>/mcp` for ChatGPT configured with no additional authentication.

The wildcard route uses a constant-time exact token comparison, returns `404` for a wrong token,
removes any caller-supplied authorization header, injects the separate backend key, and redacts the
secret path from audit context. Central Caddy discards access logs for the entire dedicated host.
Treat the complete URL as a password. Do not print it in deployment transcripts or repository files.

The personal deployment currently uses the dedicated backend API-key row ID as its persisted
principal. Rotate the independent URL token freely, but preserve the backend key during ordinary
upgrades. Replacing that backend key requires a single database transaction that rewrites the old
principal ID to the new key ID across every monitoring table; otherwise the old state is orphaned.
Do not claim multi-user/OAuth readiness until an explicit credential-to-stable-principal binding is
implemented and cross-principal negative tests pass.

As of August 2026, OpenAI documents full custom-MCP modify/write actions as a beta capability on
ChatGPT Business, Enterprise, and Edu web workspaces. ChatGPT Pro developer mode can connect only to
read/fetch tools. This monitor's enrollment and rule-management tools are local write actions, so a
Business, Enterprise, or Edu web workspace with developer mode and the relevant actions enabled is
required for the complete setup flow. Pro can use only the tools ChatGPT accepts as read/fetch.

## Preflight and deployment

1. Retrieve the current Drive runbook and inspect the live Docker projects, `edge` membership,
   Caddy files/checksums, hostnames, DNS, state paths, resources, backups, and unrelated worktrees.
2. Build and fully validate the exact source commit outside production. Pin the image immutably.
3. Back up the dedicated PostgreSQL database with `pg_dump --format=custom`, and back up
   `/var/lib/openwa-monitor` if it exists, plus the exact service/Caddy/env targets that will change.
   Secret-bearing backups remain root-only mode `0600`.
4. Install this Compose file and executable `check-secret-files.sh` under
   `/opt/services/openwa-monitor`, and create root-only runtime and deploy env files from the
   examples. The systemd unit refuses startup unless both secret env files are `root:root 0600`.
5. Render Compose with the real deploy file and assert: no `ports`, no Docker socket/DOCKER_HOST,
   read-only root, intended volume only, exact edge alias, and immutable image.
6. Start only this Compose project. Verify health and `POST /mcp` from inside the edge network.
7. Add the smallest exact Caddy host/snippet, validate the complete live configuration with the live
   environment, and recreate only `edge-caddy-1`.
8. Run every acceptance gate below and prove unrelated services were not restarted or degraded.

## Acceptance gates

1. Container's private readiness check is healthy, with zero restarts, no application host port,
   no Docker socket, and no public readiness route.
2. Public HTTP redirects to HTTPS; TLS and the dedicated hostname are correct.
3. Wrong token path and public direct `/mcp` both return `404`; ordinary API-key `/mcp` remains
   reachable only through the private edge network for administration.
4. Permanent URL completes MCP `initialize` and advertises only the 21 monitoring/enrollment tools.
5. Generic send, block, invite, arbitrary history/media, and group-administration tools are absent.
6. An out-of-scope session is rejected before resource existence is disclosed.
7. Enrollment returns a PNG `ImageContent` block with `no-store`; QR bytes appear in no log, webhook,
   WebSocket, hook, audit row, database, or backup.
8. Group selection, rule create/preview/update, synthetic or controlled match retrieval, digest
   acknowledgment, and non-repetition succeed.
9. A service restart preserves the permanent token, backend key, WhatsApp auth state, rules, matches,
   and cursor behavior. An authenticated session auto-starts; an unpaired session does not.
10. PostgreSQL backup and restore include every monitoring table; the separate main SQLite/auth-state
    backup and rollback to the prior image/database are proven.
11. Representative unrelated public services and Remote Browser remain healthy and unchanged.
12. In a supported ChatGPT Business, Enterprise, or Edu web workspace, **Scan Tools** succeeds and
    an actual local write such as `WhatsAppAuthBegin` or `MonitorSetGroup` reaches the server after
    the normal ChatGPT confirmation. Pro read/fetch-only discovery is not evidence that the full
    enrollment/configuration workflow is supported.

Real WhatsApp acceptance uses a disposable number and dedicated monitored/unmonitored groups. The
operator must scan the short-lived QR; automated CI never does.

## Upgrade and rollback

Routine upgrades change only the immutable image in `deploy.env`, then recreate this Compose project.
Never rotate or reconstruct `runtime.env` credentials during an image upgrade. Before a schema change,
retain a compatible PostgreSQL dump, main SQLite/auth-state backup, and the prior
image/deploy/service/Caddy files.

Rollback restores the prior image selection and compatible state, recreating only this service. If a
Caddy change caused the failure, restore its exact backup and recreate only central Caddy. Never use
`docker compose down --volumes`, restart all Docker, or restart unrelated edge applications.
