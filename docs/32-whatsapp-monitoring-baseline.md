# 32 - WhatsApp Monitoring Phase 0 Architecture Baseline

**Status:** Phase 0 decision record; implementation proceeds from this baseline  
**Source snapshot:** the fork's monitoring contract was reconciled with fetched
`upstream/main` `e1fd3f66` on 2026-08-23 before implementation. The upstream-only
changes were release/CI metadata, not a runtime-source divergence.

This document records what the current code does, which seams the monitoring
work must reuse, what is missing, and the initial product decisions. It is not a
deployment runbook or a claim that the proposed monitoring tools already work.

## 32.1 Decisions fixed for the first implementation

1. **The first supported product mode is personal, single-tenant, self-hosted.**
   Multi-user hosting is not an implicit extension of that mode. It remains
   unsupported until stable-subject authentication and cross-tenant negative tests
   exist.
2. **A stable internal principal and an exact WhatsApp session are separate parts
   of every authorization decision.** Raw credentials are not owner identifiers.
   The monitoring layer will receive an authentication context shaped around an
   installation-scoped, opaque `principalId`, a `credentialId`, role/scopes, and an
   explicit non-empty set of allowed session UUIDs. Local API-key credentials and
   public OAuth identities must be explicitly bound to that principal; neither a
   missing binding nor an empty session set means “all sessions.”
3. **API keys remain supported for local and private-network compatibility.** The
   current key ID is a credential identity, not the durable monitoring owner. This
   avoids transferring or orphaning monitoring state merely because a key is
   rotated.
4. **A published or multi-user ChatGPT connection requires OAuth 2.1 conforming to MCP
   authorization.** For this explicitly authorized personal deployment, a distinct
   high-entropy token-in-path edge bridge may exact-match and rewrite to `/mcp` while
   injecting a separately stored session-scoped backend key. It is single-user only,
   excluded from access logs, rotatable, and not represented as OAuth.
5. **Monitoring is a cohesive OpenWA domain.** It will reuse the session lifecycle,
   engine registry, neutral event envelope, group service, message persistence,
   audit service, and agent-tool registry. It will not be a detached Baileys-only
   MCP server.
6. **The WhatsApp data path remains read-only.** Selecting groups, saving rules,
   and acknowledging matches are narrowly scoped local control-plane writes. They
   require a separate monitoring-write capability; enabling them must not expose
   the generic WhatsApp write tool set.
7. **Groups are stored by exact neutral group JID; names are labels.** A save may
   carry an `expectedName` conflict check, but never resolves an ambiguous name by
   guessing.
8. **The reliable notification model is pull-based.** OpenWA records candidates;
   ChatGPT or another authorized client polls a bounded, opaque-cursor digest and
   acknowledges it transactionally. MCP alone is not a background push channel.
9. **Deterministic matching works without a model provider.** Semantic topic and
   urgency assessment belongs in the companion skill by default. Any future
   server-side classifier is optional, explicitly configured, data-minimizing, and
   fail-visible.

## 32.2 Current architecture and reusable seams

### MCP and agent tools

The MCP module is loaded only when `MCP_ENABLED=true`, then mounts `POST /mcp` on
the existing HTTP server ([`src/app.module.ts`](../src/app.module.ts#L68-L81)). Its
Streamable HTTP adapter is stateless: a fresh server and transport are created per
request, with no MCP session ID, GET reconnect, or DELETE lifecycle
([`src/modules/mcp/mcp.server.ts`](../src/modules/mcp/mcp.server.ts#L150-L164),
[`src/modules/mcp/mcp.server.ts`](../src/modules/mcp/mcp.server.ts#L218-L254)).

The protocol-neutral seam is already strong:

- `ToolDescriptor` carries a stable name, description, Zod input contract,
  read/write tier, destructive/idempotent hints, minimum role, session-scoping
  marker, and handler ([`src/core/agent-tools/tool-descriptor.ts`](../src/core/agent-tools/tool-descriptor.ts#L5-L25)).
- The registry is an explicit allowlist and can return reads only
  ([`src/core/agent-tools/tool-registry.service.ts`](../src/core/agent-tools/tool-registry.service.ts#L5-L24)).
- The invoker orders authorization before validation and handler execution; a
  session-scoped tool must supply a non-empty `sessionId` before key validation
  ([`src/core/agent-tools/tool-invoker.ts`](../src/core/agent-tools/tool-invoker.ts#L31-L76)).
- The adapter derives MCP read-only, destructive, and idempotent annotations from
  descriptors ([`src/modules/mcp/mcp.server.ts`](../src/modules/mcp/mcp.server.ts#L105-L143)).
- Read-only is the secure default. Only the literal `MCP_READONLY=false` publishes
  the generic write tools ([`src/modules/mcp/mcp.server.ts`](../src/modules/mcp/mcp.server.ts#L189-L197)).
- The current registry contains 51 curated tools and deliberately omits session
  create/start/QR/pairing/logout operations
  ([`src/core/agent-tools/tool-registry.spec.ts`](../src/core/agent-tools/tool-registry.spec.ts#L40-L100),
  [`src/core/agent-tools/tools/session.tools.ts`](../src/core/agent-tools/tools/session.tools.ts#L14-L140)).

The transport also has separate pre-auth IP and post-auth credential rate limits.
Both are process-local sliding windows, so they are useful seams but not a
distributed limiter ([`src/modules/mcp/mcp-rate-limit.ts`](../src/modules/mcp/mcp-rate-limit.ts#L18-L75),
[`src/modules/mcp/mcp.server.ts`](../src/modules/mcp/mcp.server.ts#L166-L187)).

**Reuse:** add focused monitoring and enrollment descriptors and continue to call
domain services through the registry/invoker. Keep enrollment image/resource
support isolated in the MCP adapter.

**Gap:** `ToolDescriptor` has no per-tool authentication `securitySchemes`, the MCP
server has no OAuth discovery/validation path, and ordinary tool errors cannot
carry the OAuth challenge metadata ChatGPT needs. Result shaping currently returns
text/JSON or an embedded base64 resource, not protected one-time QR image content
([`src/modules/mcp/tool-result.ts`](../src/modules/mcp/tool-result.ts#L7-L36)).

### MCP client authentication and session authorization

The current credential model is a hashed API key with `ADMIN`, `OPERATOR`, or
`VIEWER` role, optional IP allowlist, optional session allowlist, active flag, and
expiry ([`src/modules/auth/entities/api-key.entity.ts`](../src/modules/auth/entities/api-key.entity.ts#L3-L43)).
The MCP adapter accepts `X-API-Key` or treats any bearer value as an API key
([`src/modules/mcp/mcp.server.ts`](../src/modules/mcp/mcp.server.ts#L31-L44)).
`AuthService.validateApiKey` enforces active/expiry/IP/session restrictions and
role hierarchy ([`src/modules/auth/auth.service.ts`](../src/modules/auth/auth.service.ts#L426-L493)).

For session-scoped MCP tools, the invoker supplies the requested session UUID to
the existing `allowedSessions` check. Aggregate session listing separately filters
through the key's allowlist ([`src/core/agent-tools/tools/session.tools.ts`](../src/core/agent-tools/tools/session.tools.ts#L16-L38)).
Keys with an IP allowlist fail closed over MCP because the invoker currently passes
no client IP to `validateApiKey` ([`src/core/agent-tools/tool-invoker.ts`](../src/core/agent-tools/tool-invoker.ts#L6-L16),
[`src/modules/auth/auth.service.ts`](../src/modules/auth/auth.service.ts#L447-L459)).

**Reuse:** role evaluation, existing session allowlists, auth-before-validation
ordering, failure audit hooks, and pre/post-auth throttles.

**Gap:** there is no stable end-user subject, OAuth issuer/audience/scope validation,
principal-to-credential binding, or deny-by-default monitoring session grant. In the
current API-key model a null/empty `allowedSessions` means unrestricted for aggregate
listing, and the service-level session check only runs when a session ID is present
([`src/modules/session/session.service.ts`](../src/modules/session/session.service.ts#L304-L315),
[`src/modules/auth/auth.service.ts`](../src/modules/auth/auth.service.ts#L462-L467)).
Monitoring must not inherit that implicit-all interpretation.

### WhatsApp session lifecycle and enrollment

Sessions are persistent UUID rows with a finite connection status, phone/push name,
configuration, and optional multi-node ownership lease fields
([`src/modules/session/entities/session.entity.ts`](../src/modules/session/entities/session.entity.ts#L6-L87)).
One live engine instance is registered per session UUID, and callbacks are fenced by
engine identity so a stopped or superseded engine cannot mutate its replacement
([`src/engine/engine-registry.service.ts`](../src/engine/engine-registry.service.ts#L19-L116)).

REST already implements the necessary low-level verbs: create/start are operator
actions, creation rejects session-scoped keys, and logout explicitly unlinks the
device and clears local credential state
([`src/modules/session/session.controller.ts`](../src/modules/session/session.controller.ts#L65-L85),
[`src/modules/session/session.controller.ts`](../src/modules/session/session.controller.ts#L193-L224),
[`src/modules/session/session.controller.ts`](../src/modules/session/session.controller.ts#L262-L318)).
The engine-neutral lifecycle exposes QR, pairing code, status, phone, and push-name
operations on both adapters ([`src/engine/interfaces/whatsapp-engine.interface.ts`](../src/engine/interfaces/whatsapp-engine.interface.ts#L832-L874)).

Current QR and pairing behavior is not a bounded enrollment facade. REST returns the
raw QR string and pairing code ([`src/modules/session/session.service.ts`](../src/modules/session/session.service.ts#L551-L588)).
The engine QR callback also sends the QR through session webhooks and WebSocket
subscribers, with no principal/flow binding or one-time resource contract
([`src/modules/session/session-engine-event-wiring.ts`](../src/modules/session/session-engine-event-wiring.ts#L115-L140)).
The whatsapp-web.js pairing operation is available only in `QR_READY`; Baileys needs
an initialized socket ([`src/engine/adapters/wwebjs-lifecycle.ts`](../src/engine/adapters/wwebjs-lifecycle.ts#L934-L951),
[`src/engine/adapters/baileys-lifecycle.ts`](../src/engine/adapters/baileys-lifecycle.ts#L761-L770)).

**Reuse:** session lifecycle controls, finite engine status, teardown fences,
ownership leases, and adapter QR/pairing capabilities.

**Gap:** add a principal/session-scoped enrollment state machine with flow ID,
expiry, idempotent begin, cancel, safe status, challenge generation limits, and a
destructive confirmed disconnect. QR delivery must bypass the existing raw
webhook/text path and use short-lived image content or a protected single-use
resource.

### Group discovery and selection

`GroupFindAll` and `GroupFindOne` are already session-scoped read tools that call
`GroupService` ([`src/core/agent-tools/tools/group.tools.ts`](../src/core/agent-tools/tools/group.tools.ts#L13-L37)).
The service resolves the live engine, pages the list after the engine returns it,
and maps a missing group to a not-found response
([`src/modules/group/group.service.ts`](../src/modules/group/group.service.ts#L23-L61)).
The neutral group shape already has stable `id`, mutable `name`, and optional
participant count ([`src/engine/interfaces/whatsapp-engine.interface.ts`](../src/engine/interfaces/whatsapp-engine.interface.ts#L194-L201)).

Both engines map their own group APIs into that shape. whatsapp-web.js reads the
loaded chat list, while Baileys adds its own deadline specifically so a transport
timeout cannot masquerade as an empty group list
([`src/engine/adapters/wwebjs-groups.ts`](../src/engine/adapters/wwebjs-groups.ts#L82-L111),
[`src/engine/adapters/baileys-groups.ts`](../src/engine/adapters/baileys-groups.ts#L132-L168)).

**Reuse:** the compact neutral group DTO and exact-JID lookup.

**Gap:** there is no persisted monitoring allowlist, current-name conflict check,
rule count, or purpose-built response that hides unselected groups from digest
operations. Group selection must never call the existing group membership or
metadata write methods.

### Message events, reads, and persistence

The engine boundary already normalizes JID dialects and defines a useful live
message envelope: session-independent message ID, chat ID, sender/author, body,
neutral message type, timestamp, direction, group flag, structured mentions,
quoted reference, and media metadata
([`src/engine/interfaces/whatsapp-engine.interface.ts`](../src/engine/interfaces/whatsapp-engine.interface.ts#L1-L15),
[`src/engine/interfaces/whatsapp-engine.interface.ts`](../src/engine/interfaces/whatsapp-engine.interface.ts#L62-L151)).
Both adapters populate structured mentions at their mapping boundary
([`src/engine/adapters/message-mapper.ts`](../src/engine/adapters/message-mapper.ts#L75-L128),
[`src/engine/adapters/baileys-message-mapper.ts`](../src/engine/adapters/baileys-message-mapper.ts#L337-L413)).

The central `MessageProjector` is the live seam. It rejects stale engines, applies
ephemeral-message policy, persists an inbound row, uses
`UNIQUE(sessionId, waMessageId)` as the atomic duplicate oracle, then dispatches
accepted events to plugins, webhooks, automation, and WebSocket consumers
([`src/modules/session/message-projector.service.ts`](../src/modules/session/message-projector.service.ts#L122-L149),
[`src/modules/session/message-projector.service.ts`](../src/modules/session/message-projector.service.ts#L239-L340)).
Edits update the stored body, revokes blank it and set type `revoked`, and both are
session-scoped ([`src/modules/session/message-mutation-projector.ts`](../src/modules/session/message-mutation-projector.ts#L96-L107),
[`src/modules/session/message-projector.service.ts`](../src/modules/session/message-projector.service.ts#L545-L572)).

Two read paths already exist:

- `MessageList` reads the local database, scoped by session with optional chat and
  sender filters and a 100-row ceiling
  ([`src/core/agent-tools/tools/message.tools.ts`](../src/core/agent-tools/tools/message.tools.ts#L75-L97),
  [`src/modules/message/message.service.ts`](../src/modules/message/message.service.ts#L219-L267)).
- `MessageHistory` calls the live engine with bounded normal/deep limits and media
  disabled unless requested ([`src/core/agent-tools/tools/message.tools.ts`](../src/core/agent-tools/tools/message.tools.ts#L98-L119),
  [`src/modules/message/message.service.ts`](../src/modules/message/message.service.ts#L385-L419)).

The existing `messages` table stores the important lookup fields and a unique
session/message identity, but its generic JSON metadata currently persists only
media, quoted-message, and call information. It does **not** persist structured
mentions, location, ephemeral duration, engine source, or a normalization version
([`src/modules/message/entities/message.entity.ts`](../src/modules/message/entities/message.entity.ts#L34-L123),
[`src/modules/session/message-row.mapper.ts`](../src/modules/session/message-row.mapper.ts#L17-L47)).
History backfill is persist-only and deduplicated, without live dispatch
([`src/modules/session/message-history-projector.ts`](../src/modules/session/message-history-projector.ts#L10-L96)).

Current inbound media download is enabled unless explicitly disabled, and media may
be persisted inline as base64 within caps
([`src/engine/adapters/inbound-media-cap.ts`](../src/engine/adapters/inbound-media-cap.ts#L64-L72),
[`src/engine/adapters/inbound-media-cap.ts`](../src/engine/adapters/inbound-media-cap.ts#L128-L150)).
`MessageList` applies an aggregate response budget, but it still returns raw message
entities and may include a large newest payload
([`src/modules/message/message.service.ts`](../src/modules/message/message.service.ts#L30-L93)).

**Reuse:** normalized live events, existing persisted message identity, session/chat
queries, edit/revoke handling, and history as a bounded preview source where the
active engine supports it.

**Gap:** add a monitoring projection that preserves structured mention and matching
evidence without duplicating auth state or media bytes. Digest tools need
purpose-built safe DTOs that never return inline media by default. Preview must
report engine capability failures explicitly: synchronous live history is not
available on Baileys, which returns an unsupported error
([`src/engine/adapters/baileys.adapter.ts`](../src/engine/adapters/baileys.adapter.ts#L562-L570)).

### Deterministic webhook filters

The current filter registry supports `sender`, `recipient`, `body`, `type`,
`isGroup`, `fromMe`, `hasMedia`, and structured `mentions`. In a group, `sender`
intentionally resolves the participant author rather than the group JID
([`src/modules/webhook/filters/filter-types.ts`](../src/modules/webhook/filters/filter-types.ts#L65-L136)).
Filters are bounded at 20 conditions, 100 values per ID/enum condition, and 1,000
characters per text value ([`src/modules/webhook/filters/filter-validation.ts`](../src/modules/webhook/filters/filter-validation.ts#L18-L84)).
Evaluation canonicalizes JIDs, supports known LID-to-phone mappings, and requires
every applicable condition to pass
([`src/modules/webhook/filters/filter-evaluator.ts`](../src/modules/webhook/filters/filter-evaluator.ts#L17-L105)).

**Reuse:** neutral identity comparison, structured mentions, message-type vocabulary,
bounded validation patterns, and cheap deterministic predicates.

**Gap:** the filter model is AND-only and webhook-scoped. It has no stable chat/group
field, `any` composition, exclusions, phrase/whole-word policy, regex safety budget,
sender denylist, quiet hours, priority scoring, versioning, preview evidence,
semantic stage, or persisted matches. Do not overload `sender`; add an exact
`groupJid`/`chatId` predicate.

### Persistence boundary

The application uses a separate always-SQLite `main` database for auth/audit and a
`data` database for sessions, messages, webhooks, engine stores, and related domains.
The data connection supports SQLite or PostgreSQL and has an explicit migration set;
its CLI data source keeps `synchronize: false`
([`src/database/data-source-main.ts`](../src/database/data-source-main.ts#L17-L40),
[`src/database/data-source.ts`](../src/database/data-source.ts#L20-L45),
[`src/database/data-source.ts`](../src/database/data-source.ts#L49-L100)).

**Decision:** monitoring configuration, normalized candidates, matches, cursors, and
non-secret enrollment-flow metadata belong in the `data` connection because they
are session-owned. Principal credential material remains in the authentication
boundary; WhatsApp auth-store contents remain in the existing engine stores.

**Gap:** there are no monitoring entities or migrations. Every table must carry
explicit `principalId` and `sessionId` ownership as applicable, use a stable
session/message dedup key, and support SQLite and PostgreSQL migrations. Cursor
acknowledgment must be transactional so a crash neither skips nor repeats committed
work.

### Engine behavior and risk boundary

`EngineFactory` registers both `whatsapp-web.js` and Baileys as built-in engine
plugins and creates them behind `IWhatsAppEngine`
([`src/engine/engine.factory.ts`](../src/engine/engine.factory.ts#L25-L95),
[`src/engine/engine.factory.ts`](../src/engine/engine.factory.ts#L98-L135)). The
neutral interface is the monitoring dependency; monitoring code must not import a
concrete adapter.

The engines are not equivalent. Known relevant examples are different liveness
probes, pairing readiness, and Baileys' lack of synchronous chat history. A
monitoring capability matrix and engine-neutral fixtures are required, with
explicit unsupported/degraded results rather than silent semantic changes.

Both engines are unofficial, reverse-engineered WhatsApp clients and carry a
non-zero account restriction/ban risk. Development and manual acceptance must use a
disposable number, avoid sends, and never load-test WhatsApp. whatsapp-web.js is
typically heavier because it runs Chromium; Baileys is lighter but may present a
different fingerprint. Neither eliminates account risk.

## 32.3 Public ChatGPT authentication contract

This is a current external requirement, not behavior the repository already
implements. Before implementation or deployment, re-check the current official
pages because the connector and MCP authorization contracts are time-sensitive:

- [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI MCP guide: handle authentication](https://developers.openai.com/api/docs/mcp#handle-authentication)

The implementation baseline is:

1. An authenticated MCP server is expected to implement OAuth 2.1 conforming to
   the MCP authorization specification.
2. The MCP resource server publishes protected-resource metadata, normally at
   `/.well-known/oauth-protected-resource`, and unauthenticated responses advertise
   it in a Bearer `WWW-Authenticate` challenge.
3. The authorization server publishes OAuth or OpenID Connect discovery metadata
   with exact issuer, authorization endpoint, token endpoint, supported token
   endpoint authentication methods, and `S256` in
   `code_challenge_methods_supported`.
4. ChatGPT uses authorization code with PKCE `S256`. The `resource` value is echoed
   through authorization and token requests and represented in the issued token,
   commonly as its audience.
5. Client ID Metadata Documents (CIMD) are preferred where supported. Dynamic client
   registration (DCR) remains supported; a predefined client may also be used when
   deliberately configured.
6. The resource server verifies issuer, audience/resource, expiry, and required
   scopes on every request. Successful authentication at connection time is not a
   substitute for per-call verification.
7. Each tool declares its authentication policy with `securitySchemes`. When a tool
   needs authentication or more scope, its error result carries
   `_meta["mcp/www_authenticate"]` with an actionable Bearer challenge. Resource
   metadata, per-tool schemes, and runtime challenges are all required for ChatGPT's
   tool-level linking UI.

Therefore a published or multi-user deployment needs an OAuth-aware request context and
tool metadata extension; treating an OAuth access token as an OpenWA API key is not an
acceptable bridge. The personal tokenized-URL exception above is a front-proxy credential,
not an OAuth substitute for multi-user hosting.

## 32.4 Target data flow

```text
ChatGPT / MCP client
  -> OAuth or private API-key adapter
  -> AuthContext(principalId, credentialId, role/scopes, allowedSessionIds)
  -> focused monitoring/enrollment ToolDescriptors
  -> monitoring domain authorization (before existence checks)
  -> SessionService / GroupService / EngineRegistry / MessageProjector
  -> compact monitor projection and deterministic evaluator
  -> matches + opaque cursor in the data database
  -> bounded MonitorGetDigestBatch
  -> optional semantic judgment in the companion skill
  -> transactional MonitorAcknowledgeMatches
```

Every inbound message, group name, sender label, link, file name, caption, and quoted
body is untrusted data throughout this flow. It may contribute matching evidence; it
never supplies authorization, changes configuration, selects tools, or becomes
executable prompt/instruction content.

## 32.5 Precise implementation gaps and acceptance implications

| Gap                                     | Required outcome                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable principal context                | Add explicit credential-to-principal binding and deny-by-default session grants; authorize before any resource existence check.                                                                     |
| OAuth 2.1 for public ChatGPT            | Add protected-resource metadata, authorization-server discovery integration, PKCE/resource/audience handling, per-request validation, tool `securitySchemes`, and auth challenges.                  |
| Focused MCP surface                     | Add monitoring and enrollment descriptors; do not expose REST wholesale or enable the generic write surface.                                                                                        |
| Enrollment facade                       | Add bounded states, flow identity, expiry, replay protection, rate limits, safe QR delivery, explicit pairing mode, cancellation, reconnect, and confirmed disconnect.                              |
| Monitoring schema                       | Add profiles/groups/rules/matches/cursors and optional non-secret auth-flow rows with SQLite/PostgreSQL migrations.                                                                                 |
| Message projection                      | Persist only matching-relevant normalized fields, structured mentions, engine/normalization version, compact media metadata, mutation state, and dedup identity. Never copy media bytes by default. |
| Rules                                   | Add declarative/versioned `any`/`all`, exclusions, stable group predicate, deterministic predicates, hard limits, quiet hours, priorities, and concise evidence. No executable code or SQL.         |
| Preview                                 | Bound messages and context; distinguish empty history from unavailable/timed-out history; surface engine capability gaps.                                                                           |
| Digest and cursor                       | Use opaque pagination, transactional acknowledge/conflict handling, retention, and restart-safe non-repetition.                                                                                     |
| Semantic stage                          | Default to client/skill judgment over bounded candidates; optional server classifier must be opt-in, budgeted, schema-validated, and fail-visible.                                                  |
| Data minimization and injection defense | Return purpose-built DTOs, strip inline media, truncate bodies with stable references, label message content as data, and add adversarial fixtures.                                                 |
| Audit and errors                        | Add stable error codes, principal/credential provenance for configuration changes, redacted auth failures, and no message bodies or secret challenges in logs.                                      |
| Engine qualification                    | Test both adapters for QR, pairing or explicit unsupported results, groups, mentions, media/captions, edit/revoke, reconnect duplicates, history, owner identity, and `fromMe`.                     |
| Polling truthfulness                    | Document and test bounded polling; do not claim MCP wakes ChatGPT. Any future push worker is a separate consented subsystem.                                                                        |

## 32.6 Deployment boundary

No deployment values are decided in this baseline. In particular, the service slug,
container name, image digest, private port, edge-network alias, hostname, route,
OAuth issuer/client configuration, secret paths, state paths, backup target, and
rollback commands remain unset.

The current **CodexGUI Container Deployment Runbook** was retrieved from the canonical
`Codex` Google Drive hierarchy on 2026-08-23. It remains the only owner of shared edge,
Caddy, host-layout, and rollback facts. No hostname, alias, token, or private port is
fixed by this source document; deployment still requires live-state inspection.

## 32.7 Recorded local validation

The source snapshot above was exercised locally on 2026-08-23 with Node
`v22.23.1`, npm `10.9.8`, Docker `29.1.3`, and Docker Compose `2.40.3`.

Passed lanes:

- locked root/dashboard install;
- Prettier, TypeScript, ESLint with three existing warnings and no errors;
- 115 script tests and 264 documentation/contract tests;
- 5,912 backend unit tests across 343 passing suites, with 6 skipped tests and 2
  skipped suites;
- 181 e2e tests across 22 passing suites, with the repository's existing
  skips/todos;
- root dependency policy (one explicitly allowlisted advisory affecting five
  dependency entries) and a clean dashboard dependency audit;
- 332 dashboard unit tests, dashboard lint/format/i18n, and backend/dashboard
  production builds;
- OpenAPI snapshot parity (157 paths); and
- both development and production Compose configuration renders.

Environment notes:

- This host defaults to `umask 0077`. Two permission-test preconditions expect a
  conventional `0022`; they pass when that test umask is set. A chat-media test
  timed out only while the backend and e2e suites competed for CPU and passed when
  rerun without contention.
- One `npm test -- --runInBand` invocation returned status 1 after reporting every
  suite/test passed. The equivalent clean direct Jest rerun under `umask 0022`
  exited 0 with the counts above. Treat the wrapper result as a baseline runner
  flake to re-check, not as an ignored failing assertion.
- The container image was not built. The installed Docker falls back to the legacy
  builder, which cannot expand the Dockerfile's `$BUILDPLATFORM`, while enabling
  BuildKit reports that the `buildx` component is missing. The Dockerfile was not
  weakened to accommodate the obsolete builder, and the non-root image smoke was
  therefore not run.
- `upstream/main` release metadata remains to be reconciled before Phase 1; no
  merge commit was created as part of this documentation work.

## 32.8 Phase 0 exit check

This baseline resolves the initial product mode and records the source-grounded
seams and gaps. Phase 0 is not fully complete until the separate threat model and
data-flow review are accepted and the relevant unmodified test/build baseline is
recorded. No production readiness, live WhatsApp acceptance, public OAuth flow, or
deployment verification is claimed here.
