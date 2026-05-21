# glide-dev — contributor reviewer knowledge

Concatenated from the glide-dev skill bundle in valkey-skills. Do not edit this
file directly; regenerate from `scripts/build-glide-skill.sh`.

---

## glide-dev SKILL.md


# Valkey GLIDE Contributor Reference

## Routing

| Question | Section below |
|----------|---------------|
| Rust core, connection management, protocol | Core Architecture |
| Python / Java / Node / Go / PHP / C# / Ruby bindings and their FFI mechanism | Language Bindings |
| PubSub synchronizer, subscription management | Core Architecture (pubsub-internals reference) |
| Cluster topology, slot mapping, failover | Core Architecture (cluster-internals reference) |
| Adding a new command across protobuf + Rust + wrappers | Language Bindings (adding-commands reference) |
| Build environment, prerequisites, testing, test utils, cluster setup | Language Bindings (build-and-test reference) |

## Repository Structure

```
glide-core/
  src/            # Real GLIDE core (what this skill describes)
    client/       # Client impl - multiplexer, not a pool
    pubsub/       # PubSub synchronizer (desired vs actual state)
    protobuf/     # Protobuf definitions for IPC
  redis-rs/       # Vendored redis-rs fork - inheritance, NOT GLIDE code
ffi/              # C FFI surface (Python sync, Go, Java JNI, PHP, C#, Ruby)
logger_core/      # Rust logging
python/           # glide-async (UDS + PyO3) and glide-sync (FFI + CFFI)
java/             # JNI wrappers (migrated from UDS to direct JNI in 2.2)
node/             # NAPI v2 wrappers, UDS-backed
go/               # CGO against ffi/
utils/            # Test utilities, cluster scripts
```

## Grep hazards (read before editing core)

These are the recurring agent mistakes. Every change touching `glide-core/` or `ffi/` should be checked against this list.

1. **GLIDE is a multiplexer, not a connection pool.** One multiplexed connection, many in-flight requests tagged with IDs. `DEFAULT_MAX_INFLIGHT_REQUESTS = 1000` is the inflight cap, not a pool size. Never say "connection pool" about the core client.
2. **Cluster client is NOT a pool of standalone clients.** `ClientWrapper` is an enum: `Standalone(StandaloneClient)` vs `Cluster { client: ClusterConnection }` - two separate types with different state machines. Cluster does not wrap standalone.
3. **`glide-core/redis-rs/` is vendored redis-rs, NOT GLIDE.** Lots of code there is inherited and not wired. Before claiming "the core does X" from `glide-core/redis-rs/**`, trace the call graph from `glide-core/src/**` outward. The real GLIDE client code is `glide-core/src/client/` (3 files: `mod.rs`, `standalone_client.rs`, `reconnecting_connection.rs`).
4. **UDS is in-process IPC, not network.** Python-async and Node talk to the Rust core over a Unix socket within the same process - just a message-passing mechanism between the language layer and the Rust runtime. Not a separate process, not a remote connection.
5. **HA/reliability and performance are both top priorities - never risk either.** HA/reliability is arbitrated first when tradeoffs force a choice, but performance is not "secondary". Every core change is measured and validated for both. No change ships if it regresses reconnect/failover behavior OR throughput/latency.
6. **Cross-language blast radius.** `glide-core/` or `ffi/` changes affect every wrapper (Python async + sync, Node, Java, Go, PHP, C#, Ruby) and both FFI modes. Validate across the matrix.
7. **Routing lives in `redis::cluster_routing` (vendored), not `request_type.rs`.** `request_type.rs` is a command-name → enum mapping, nothing more. Routing decisions come from `RoutingInfo::for_routable()` and user-specified overrides.
8. **Typo in upstream constant: `UNIX_SOCKER_DIR` (not `UNIX_SOCKET_DIR`).** In `glide-core/src/socket_listener.rs`. Grep for the misspelled name or you'll miss the socket-path source.

## Core Architecture

| Topic | Reference |
|-------|-----------|
| Three-layer design, FFI mechanisms, module structure, runtime model, command flow, key structs | [core-architecture](reference/core-architecture.md) |
| Connection model: multiplexing, inflight limiting, timeouts, reconnection, lazy connect, read-only mode | [connection-internals](reference/connection-internals.md) |
| PubSub synchronizer: desired vs actual state, reconciliation loop, resubscription | [pubsub-internals](reference/pubsub-internals.md) |
| Cluster topology: slot map, node discovery, MOVED/ASK handling, failover detection | [cluster-internals](reference/cluster-internals.md) |

## Language Bindings

| Language | Mechanism | Native Lib | IPC |
|----------|-----------|------------|-----|
| Python async | PyO3 | `python/glide-async/` | Unix socket |
| Python sync | CFFI | `ffi/` | FFI calls |
| Java | JNI | `java/src/lib.rs` | JNI calls |
| Node.js | NAPI v2 | `node/rust-client/` | Unix socket |
| Go | CGO | `ffi/` | FFI calls |
| PHP | PHP FFI | FFI extension (separate repo) | Direct FFI calls |
| C# | P/Invoke | .NET interop (separate repo) | Direct FFI calls |
| Ruby | FFI | `valkey-rb` gem (separate repo) | Direct FFI calls |

| Topic | Reference |
|-------|-----------|
| Adding commands: protobuf definition, Rust handler, language wrappers, tests | [adding-commands](reference/adding-commands.md) |
| Build and test for each language | [build-and-test](reference/build-and-test.md) |


---

## Reference: core-architecture

# GLIDE Core Architecture

Use when understanding the Rust core design, three-layer architecture, FFI mechanisms per language, the module structure, command flow, runtime model, or debugging connection/protocol issues.

## Three-Layer Design

```
Application Code (Python / Java / Node.js / Go / PHP / C# / Ruby)
        |
Language Wrapper (lightweight bindings)
        |
    FFI / CGO / napi-rs / JNI / PyO3 / Protobuf
        |
    Rust Core (glide-core)
        |
    Valkey / Redis OSS Server
```

The Rust core is the single source of truth for connection handling, protocol parsing, and cluster logic. Language wrappers never reimplement these behaviors - they delegate to the core through their respective FFI mechanism.

### Design Philosophy

The Rust core is not a standalone server-like component - it is an integral part of the client itself. The majority of a command's lifetime, after network time, is spent in the core. Creating a second client is expensive (new TCP connections to every cluster node, separate topology tracking), but adding concurrency within a single client is cheap.

## Request Pipeline

```
Language Client -> [socket/FFI] -> socket_listener -> Client -> Valkey Server
                                                   <- Response routing
                                                   <- Push notifications (PubSub)
```

### Socket Listener (`glide-core/src/socket_listener.rs`)

The socket listener is the entry point for IPC-based language bindings (Python async, Node.js). It:
1. Creates a Unix domain socket per client connection
2. Reads protobuf-encoded `CommandRequest` messages from the socket
3. Routes them to the appropriate `Client` method
4. Writes protobuf-encoded `Response` messages back

Key types: `CommandRequest`, `Response`, `ClosingReason`, `RotatingBuffer`

### Client (`glide-core/src/client/mod.rs`)

The client manages connections and command execution. Two distinct implementations, not a pool hierarchy:

- **Standalone** (`StandaloneClient` in `client/standalone_client.rs`): GLIDE's own code. Single multiplexed connection, or primary + replicas.
- **Cluster** (`ClusterConnection` from vendored `redis::cluster_async`): separate implementation with slot-based routing, maintained as a vendored fork in `glide-core/redis-rs/`.

`ClientWrapper` is an enum - `Standalone(StandaloneClient)` and `Cluster { client: ClusterConnection }` are two different animals. Cluster is not a pool of standalones.

Key components:
- `ClientWrapper` - enum dispatching to standalone or cluster
- `reconnecting_connection` - GLIDE-owned auto-reconnect state machine with backoff
- `value_conversion` - converts redis-rs `Value` to protobuf `Response`

### Protobuf IPC (`glide-core/src/protobuf/`)

All cross-language communication uses protobuf for type safety and performance:
- `connection_request.proto` - client configuration
- `command_request.proto` - individual commands, batches, cluster scan
- `response.proto` - command responses, errors

## Module Structure

| Module | File | Responsibility |
|--------|------|----------------|
| `client` | `client/mod.rs` | Top-level `Client` struct, command dispatch, lazy init |
| `client::types` | `client/types.rs` | `ConnectionRequest`, `ReadFrom`, `TlsMode`, `ConnectionRetryStrategy` |
| `client::reconnecting_connection` | `client/reconnecting_connection.rs` | `ReconnectingConnection` with state machine and backoff |
| `client::standalone_client` | `client/standalone_client.rs` | `StandaloneClient` with primary/replica topology |
| `socket_listener` | `socket_listener.rs` | Unix socket IPC for Python/Node.js wrappers |
| `cluster_scan_container` | `cluster_scan_container.rs` | Cross-layer cursor lifecycle for cluster SCAN |
| `request_type` | `request_type.rs` | Command enum mapping to Redis `Cmd` objects |
| `scripts_container` | `scripts_container.rs` | Lua script SHA1 caching for EVALSHA |
| `compression` | `compression.rs` | Optional Zstd/LZ4 compression for values |
| `errors` | `errors.rs` | Error types and message formatting |
| `pubsub` | `pubsub/` | PubSub synchronization and resubscription |
| `iam` | `iam/` | AWS IAM token management for ElastiCache/MemoryDB |
| `otel_db_semantics` | `otel_db_semantics.rs` | OpenTelemetry span attribute population |
| `rotating_buffer` | `rotating_buffer.rs` | Efficient protobuf message framing for socket IPC |

## Key Structs and Types

### Client Layer (`client/mod.rs`)

```rust
pub struct Client {
    internal_client: Arc<RwLock<ClientWrapper>>,
    request_timeout: Duration,
    inflight_requests_allowed: Arc<AtomicIsize>,
    inflight_requests_limit: isize,
    inflight_log_interval: isize,
    iam_token_manager: Option<Arc<IAMTokenManager>>,
    compression_manager: Option<Arc<CompressionManager>>,
    pubsub_synchronizer: Arc<dyn PubSubSynchronizer>,
    otel_metadata: OTelMetadata,
}

pub enum ClientWrapper {
    Standalone(StandaloneClient),
    Cluster { client: ClusterConnection },
    Lazy(Box<LazyClient>),
}
```

The `ClientWrapper::Lazy` variant enables deferred connection - the client starts as `Lazy` and transitions to `Standalone` or `Cluster` on the first command via `get_or_initialize_client()`.

### Connection Configuration (`client/types.rs`)

```rust
pub struct ConnectionRequest {
    pub addresses: Vec<NodeAddress>,
    pub cluster_mode_enabled: bool,
    pub read_from: Option<ReadFrom>,
    pub tls_mode: Option<TlsMode>,
    pub request_timeout: Option<u32>,
    pub connection_timeout: Option<u32>,
    pub connection_retry_strategy: Option<ConnectionRetryStrategy>,
    pub inflight_requests_limit: Option<u32>,
    pub lazy_connect: bool,
    pub periodic_checks: Option<PeriodicCheck>,
    pub pubsub_subscriptions: Option<PubSubSubscriptionInfo>,
    pub compression_config: Option<CompressionConfig>,
    pub tcp_nodelay: bool,
    // ... additional fields
}
```

## FFI Mechanisms by Language

Two distinct communication paths:

### Socket IPC Path (Python async, Node.js)

```
Wrapper (same process)  <--UDS-->  socket_listener  -->  glide-core
```

**UDS here is in-process IPC, not a network connection.** The wrapper and the Rust core run in the same process - the Unix socket is just a message-passing channel between the language layer and the Rust Tokio runtime. The core is not a separate process.

`socket_listener.rs` builds the socket path as `{UNIX_SOCKER_DIR}/{SOCKET_FILE_NAME}-{pid}-{uuid}.sock` (yes, `UNIX_SOCKER_DIR` is the verbatim constant name in upstream source - typo preserved; its value is `"/tmp"`). The PID is included so the name stays unique in Docker containers where PIDs can be reused. Requests are protobuf-encoded `CommandRequest` messages framed by varint length prefixes. `RotatingBuffer::new(65_536)` handles framing.

Key constants (verified in `socket_listener.rs`):
- `SOCKET_FILE_NAME = "glide-socket"`
- `MAX_REQUEST_ARGS_LENGTH = 2_i32.pow(12) = 4096` (source has TODO "find the right number")

### Direct FFI Path (Java, Go, Python sync, PHP, C#)

```
Wrapper  -->  JNI / CGO / CFFI / FFI ext / .NET interop  -->  glide-core
```

No socket involved - direct function calls through the language's FFI.

### Per-Language Bindings

| Language | Binding Crate | Mechanism | Communication |
|----------|--------------|-----------|---------------|
| Python (async) | `python/glide-async/` | PyO3 | Unix socket IPC + Protobuf |
| Python (sync) | `python/glide-sync/` | CFFI | Direct FFI via `ffi/` crate |
| Node.js | `node/rust-client/` | napi-rs (NAPI v2) | Unix socket IPC + Protobuf |
| Java | `java/src/` | JNI | Direct JNI calls + Protobuf |
| Go | via `ffi/` | CGO + cbindgen | Direct FFI calls |
| PHP | via FFI extension | PHP FFI | Direct FFI calls |
| C# | via .NET interop | P/Invoke | Direct FFI calls |

**Python Async** - `python/glide-async/src/lib.rs` uses PyO3, calls `start_socket_listener`, Python sends Protobuf over socket. Responses via `value_from_pointer(py, pointer: u64)`.

**Node.js** - `node/rust-client/src/lib.rs` uses `#[napi]` macro, socket listener path. Exports constants: `DEFAULT_REQUEST_TIMEOUT_IN_MILLISECONDS`, `DEFAULT_CONNECTION_TIMEOUT_IN_MILLISECONDS`, `DEFAULT_INFLIGHT_REQUESTS_LIMIT`.

**Java** - `java/src/lib.rs` uses JNI. Migrated from UDS+Protobuf to direct JNI for Windows support. Entry points are `Java_glide_ffi_resolvers_*` + `Java_glide_internal_GlideNativeBridge_createClient`; protobuf is still used for command encoding across the JNI boundary (see `java/src/protobuf_bridge.rs`). Compression runs through the shared `process_command_for_compression` path in `glide-core/src/socket_listener.rs` - Java does NOT have its own copy.

**Go and Python Sync** - `ffi/src/lib.rs` provides C-compatible API with `extern "C"` functions. Go uses CGO with cbindgen headers, Python sync uses CFFI. `#[repr(C)]` structs for cross-language compatibility.

## Runtime Model

GLIDE creates a single-threaded Tokio runtime in a dedicated OS thread:

```rust
static RUNTIME: OnceCell<GlideRt> = OnceCell::new();

pub struct GlideRt {
    pub runtime: Handle,
    pub(crate) thread: Option<JoinHandle<()>>,
    shutdown_notifier: Arc<Notify>,
}
```

`get_or_init_runtime()` initializes once per process. All async operations run on this runtime. Thread named `"glide-runtime-thread"`. All GLIDE client instances in a process share one event loop.

## Command Flow

1. Application calls a command method on the language wrapper
2. Wrapper serializes the command (Protobuf for socket IPC, direct struct for FFI)
3. Rust core receives the command in `Client::send_command()`
4. Core checks for IAM token refresh if IAM auth is configured
5. Core calls `get_or_initialize_client()` (handles lazy init on first call)
6. Core reserves an inflight slot via `reserve_inflight_request()`
7. Core determines routing (`RoutingInfo::for_routable()` or user-specified)
8. Command is dispatched to `StandaloneClient` or `ClusterConnection`
9. Response is optionally decompressed and type-converted
10. Post-command hooks run (SELECT updates db tracking, AUTH updates credentials)
11. Result is returned to the wrapper via the FFI mechanism

## Dependencies

- `redis` - vendored fork at `glide-core/redis-rs/`. Low-level RESP, cluster routing, slot map, `MultiplexedConnection`, `ClusterConnection`. Inheritance: not every function reachable from the tree is actually wired by GLIDE - trace callers from `glide-core/src/**` before claiming behavior.
- `tokio` - single-threaded runtime on a dedicated OS thread (`"glide-runtime-thread"`).
- `protobuf` - IPC serialization for the UDS path; also used inside JNI on Java.
- `telemetrylib` - OpenTelemetry integration (exports `GlideOpenTelemetry` + builder types from `lib.rs`).

---

## Reference: connection-internals

# Connection Model Internals

Use when working on GLIDE's single-connection-per-node design, multiplexing, inflight request limiting, request/connection timeouts, reconnection backoff, lazy connection, periodic health checks, or read-only mode.

## Single Multiplexed Connection

GLIDE uses one `MultiplexedConnection` per node - not a connection pool. All requests pipeline through this connection via Valkey's built-in pipelining protocol. The connection is wrapped in `ReconnectingConnection` (`client/reconnecting_connection.rs`):

```rust
struct InnerReconnectingConnection {
    state: Mutex<ConnectionState>,
    backend: ConnectionBackend,
}

enum ConnectionState {
    Connected(MultiplexedConnection),
    Reconnecting,
    InitializedDisconnected,
}
```

## Inflight Request Limiting

Default limit is 1000 concurrent inflight requests per client:

```rust
pub const DEFAULT_MAX_INFLIGHT_REQUESTS: u32 = 1000;
```

The 1000 value is 20x the theoretical minimum for 50K req/s at 1ms latency (Little's Law). The `Client` struct holds `inflight_requests_allowed: Arc<AtomicIsize>`. Before each command, `reserve_inflight_request()` atomically decrements; `InflightRequestTracker` increments on drop. If no slots available, returns error: `"Reached maximum inflight requests"`.

GLIDE logs inflight usage at debug level at 10% threshold intervals (`inflight_limit / 10`).

## Request Timeout

Default: 250ms (`DEFAULT_RESPONSE_TIMEOUT`).

Blocking commands (BLPOP, BRPOP, BLMOVE, BZPOPMAX, etc.) get special treatment - GLIDE parses their timeout argument and extends the request timeout by 0.5 seconds. A timeout of 0 (block forever) disables request timeout for that command.

## Connection Timeout

Default: 2000ms (`DEFAULT_CONNECTION_TIMEOUT`). Client creation adds 500ms buffer on top.

## Reconnection with Exponential Backoff

On disconnect:
1. State transitions from `Connected` to `Reconnecting`
2. `connection_available_signal` (ManualResetEvent) is reset - callers block
3. Background task spawned for reconnection

Retry uses infinite backoff duration iterator from `RetryStrategy`. Each attempt verified with PING before accepting. Reconnection continues until success or client drop.

### Permanent vs Transient Errors

During initial connection, these errors are never retried:
- `AuthenticationFailed`
- `InvalidClientConfig`
- `RESP3NotSupported`
- Messages containing `NOAUTH` or `WRONGPASS`

## Periodic Connection Checks

### Standalone Mode

3-second interval (`CONNECTION_CHECKS_INTERVAL`). Passive monitoring via disconnect notifier, not PING. Optional active heartbeat behind `standalone_heartbeat` feature flag (1-second PING interval).

### Cluster Mode

Always enabled with 3-second interval via `builder.periodic_connections_checks()`.

## Connection State Preservation

Properties tracked and restored on reconnection:

| Property | Method | Updated By |
|----------|--------|------------|
| Database ID | `update_connection_database()` | SELECT |
| Password | `update_connection_password()` | AUTH, IAM refresh |
| Username | `update_connection_username()` | AUTH |
| Client name | `update_connection_client_name()` | CLIENT SETNAME |
| Protocol version | `update_connection_protocol()` | HELLO |

## When to Create Separate Client Instances

A single multiplexed connection cannot isolate state. Separate clients needed for:
- Blocking commands (BLPOP, BRPOP, etc.) - occupy the connection
- WATCH/MULTI/EXEC - optimistic locking requires isolated connection
- Large value transfers - delays other requests
- Database isolation - SELECT is per-connection
- Different ReadFrom strategies - locked at creation time

## Batch Retry Strategies (Cluster Non-Atomic)

Core struct: `redis::cluster_async::PipelineRetryStrategy` (vendored, `glide-core/redis-rs/redis/src/cluster_async/mod.rs`).

- **`retry_server_error`** - retry commands failing with retriable errors (e.g., TRYAGAIN). May cause out-of-order execution.
- **`retry_connection_error`** - retry the entire batch on connection failure. May cause duplicate executions.

Wrapper APIs surface these under language-native names (`retryServerError` in Node/Java, `retry_server_error` in Python/Rust, `RetryServerError` in Go).

MOVED/ASK redirections are always handled automatically regardless of retry config.

## Read-Only Mode (GLIDE 2.3)

`read_only` flag in `ConnectionRequest` (protobuf field 26):
1. Skips primary discovery - connects to replicas without requiring primary
2. Blocks write commands at client level
3. Defaults to `PreferReplica` if no explicit `ReadFrom`
4. Requires at least one successful connection to any node

Not compatible with `AZAffinity` or `AZAffinityReplicasAndPrimary` strategies.

## Custom Commands

`custom_command()` uses `RequestType::CustomCommand` (ID 1) - creates empty `Cmd::new()`, caller's arguments become the entire command. First element is the command name.

---

## Reference: pubsub-internals

# PubSub Synchronizer Internals

Use when working on GLIDE's PubSub subscription management, debugging subscription state, or understanding the reconciliation loop.

## Architecture

The `GlidePubSubSynchronizer` (in `glide-core/src/pubsub/synchronizer.rs`) implements an observer pattern:

- `desired_subscriptions` (`RwLock<PubSubSubscriptionInfo>`) - what the user wants
- `current_subscriptions_by_address` (`RwLock<HashMap<String, PubSubSubscriptionInfo>>`) - what's actually subscribed, tracked per server address

A background reconciliation task runs at a configurable interval (default: 3 seconds) to align current with desired.

## Subscription Kinds

```rust
// Cluster supports all three
const CLUSTER_SUBSCRIPTION_KINDS: &[PubSubSubscriptionKind] = &[
    PubSubSubscriptionKind::Exact,    // SUBSCRIBE
    PubSubSubscriptionKind::Pattern,  // PSUBSCRIBE
    PubSubSubscriptionKind::Sharded,  // SSUBSCRIBE
];

// Standalone only supports exact and pattern
const STANDALONE_SUBSCRIPTION_KINDS: &[PubSubSubscriptionKind] = &[
    PubSubSubscriptionKind::Exact,
    PubSubSubscriptionKind::Pattern,
];
```

## Reconciliation Loop

The `SyncDiff` struct avoids recomputation:
```rust
struct SyncDiff {
    is_synchronized: bool,
    to_subscribe: PubSubSubscriptionInfo,       // channels we want but don't have
    to_unsubscribe_by_address: HashMap<String, PubSubSubscriptionInfo>,  // channels we have but don't want
}
```

### Triggers
1. **User API call** - `subscribe()` / `unsubscribe()` modifies `desired_subscriptions` and notifies the reconciliation task
2. **Server push notification** - updates `current_subscriptions_by_address`
3. **Timer** - reconciliation runs every `reconciliation_interval` (default 3s)
4. **Topology change** - cluster slot migration triggers resubscription on new nodes

### Topology Change Handling

When cluster topology changes (slot migration, node failure):
1. Node disconnection clears that address from `current_subscriptions_by_address`
2. Migrated subscriptions are queued in `pending_unsubscribes` for the old node
3. Reconciliation loop subscribes on the new correct node
4. For removed nodes, all subscriptions are cleared and resubscribed elsewhere

## Key Design Decisions

- `OnceCell<Weak<TokioRwLock<ClientWrapper>>>` for the client reference - weak avoids circular refs, `OnceCell::set` enforces one-shot late init (see comment in `pubsub/mod.rs`).
- `Notify` primitives for efficient wake-up - no polling overhead
- `PubSubCommandApplier` trait - defined in `client/mod.rs`, implemented for `ClientWrapper`. Abstracts how subscription commands get dispatched; used by the synchronizer to send SUBSCRIBE/UNSUBSCRIBE without knowing cluster vs standalone specifics.
- Test mock: `MockPubSubSynchronizer` in `pubsub/mock.rs` mocks the whole `PubSubSynchronizer` trait (not `PubSubCommandApplier`) for unit testing higher layers without a real client.
- Separate `desired` vs `current` state prevents subscription drift.

## Files

| File | Purpose |
|------|---------|
| `glide-core/src/pubsub/mod.rs` | Module definition, re-exports |
| `glide-core/src/pubsub/synchronizer.rs` | GlidePubSubSynchronizer implementation |
| `glide-core/src/pubsub/mock.rs` | Mock implementation for testing |

## Node.js Binding Path

For the Node.js client, PubSub flows through:
1. `node/src/BaseClient.ts` - `subscribe()`, `psubscribe()`, `unsubscribe()` methods
2. `node/rust-client/src/lib.rs` - NAPI bindings call into Rust core
3. `glide-core/src/pubsub/synchronizer.rs` - reconciliation and state management
4. Messages arrive via push notifications and are routed back through NAPI to JS callbacks

---

## Reference: cluster-internals

# Cluster Topology Internals

Use when working on cluster slot mapping, failover handling, MOVED/ASK redirect logic, or topology refresh.

## Cluster is its own client, not a pool

Cluster and standalone are two different implementations in `glide-core/src/client/`. `ClientWrapper::Cluster` holds a `redis::cluster_async::ClusterConnection` (from the vendored `glide-core/redis-rs/` tree); `ClientWrapper::Standalone` holds GLIDE's own `StandaloneClient`. They do not share a code path. Do not describe cluster as "a pool of standalone clients" - that's a common but wrong mental model.

## Slot Map

`redis::cluster_slotmap::SlotMap` from the vendored redis-rs tracks which node owns which slot range (0-16383). It refreshes:

1. On initial connection (slot map built from `CLUSTER SLOTS` / `CLUSTER SHARDS`)
2. On `MOVED` redirect (stale slot mapping)
3. On `ASK` redirect (slot migration in progress - single-use, does NOT update the map)
4. Periodically via `periodic_topology_checks` (configured in `ConnectionRequest`; default interval `DEFAULT_PERIODIC_TOPOLOGY_CHECKS_INTERVAL = 60s` in `client/mod.rs`)

## MOVED vs ASK

- **MOVED**: slot permanently moved. Update slot map, retry on new node.
- **ASK**: slot mid-migration. Send `ASKING` + command to the indicated node. One-shot: the next command for the same slot still goes to the original owner until MOVED.

## Topology refresh

`CLUSTER SLOTS` (older) or `CLUSTER SHARDS` (Valkey 7.0+). Flow:

1. Fetch topology.
2. Build new `SlotMap`.
3. Diff against current node set - open connections to new nodes, close connections to removed nodes.
4. Trigger PubSub resynchronization for affected slots (see `pubsub-internals.md`).

Refresh path is in vendored `redis::cluster_async`; GLIDE adds the hook for PubSub resync via `PubSubSynchronizer::handle_topology_refresh(&SlotMap)` in `glide-core/src/pubsub/synchronizer.rs`.

## Routing decisions

Routing lives in vendored `redis::cluster_routing` (imported in `client/mod.rs` as `MultipleNodeRoutingInfo`, `ResponsePolicy`, `Routable`, `RoutingInfo`, `SingleNodeRoutingInfo`). It is NOT in `request_type.rs` - that file is only a command-name → `RequestType` enum with no routing logic.

Categories:

- **Single slot**: route to the node owning the slot of the command's key.
- **All primaries**: broadcast (FLUSHALL, DBSIZE, CONFIG SET).
- **All nodes**: broadcast to all primaries and replicas (PING via cluster, some diagnostics).
- **Random node**: pick any primary.
- **Response policy** determines how to aggregate multi-node responses: combine arrays, sum counts, take first value, all-succeeded-or-error.

Multi-key commands on the same cluster must target one slot (hash tags: `{same-slot}:key1`, `{same-slot}:key2`). Cross-slot multi-key is split and dispatched by GLIDE when the command allows it (e.g., MGET/MSET in cluster mode).

## Read-from-replica

`redis::cluster_slotmap::ReadFromReplicaStrategy` (imported in `client/mod.rs`). Configured via `ConnectionRequest::read_from`. Strategies include primary-preferred and AZ-affinity; the actual enum variants live in the vendored redis-rs.

## Connection lifecycle

Per-node connections are held by `ClusterConnection` (vendored). Reconnection, heartbeat, and IAM-token refresh are driven by GLIDE code in `reconnecting_connection.rs`:

- `HEARTBEAT_SLEEP_DURATION = 1s`
- `CONNECTION_CHECKS_INTERVAL = 3s` (not user-exposed; per source comment, improper tuning affects PubSub resiliency)
- `DEFAULT_RETRIES = 3`, `DEFAULT_RESPONSE_TIMEOUT = 250ms`, `DEFAULT_MAX_INFLIGHT_REQUESTS = 1000` (all in `client/mod.rs`)

There is no min/max "pool size" - per-node links are the multiplexed connection managed by `ReconnectingConnection`.

---

## Reference: adding-commands

# Adding New Commands to GLIDE

Use when implementing a new Valkey command across the GLIDE client.

## Steps

### 1. Add to RequestType enum (`glide-core/src/request_type.rs`)

```rust
// Add variant with next available number in the appropriate section
MyNewCommand = NNN,
```

Commands are grouped by category (Bitmap 1xx, Cluster 2xx, Connection 3xx, etc.).

### 2. Add protobuf mapping (`glide-core/src/request_type.rs`)

In the `From<ProtobufRequestType>` impl, map the protobuf variant to the Rust enum.

### 3. Implement command construction

In `request_type.rs`, add the `get_command()` match arm that builds the redis `Cmd`:

```rust
RequestType::MyNewCommand => {
    cmd("MYNEWCOMMAND")
}
```

### 4. Add to each language wrapper

**Node.js** (`node/src/Commands.ts`):
```typescript
export function createMyNewCommand(args: ...): redis_request.Command {
    return createCommand(RequestType.MyNewCommand, [...args]);
}
```

Then in `node/src/BaseClient.ts`, add the public method:
```typescript
public async myNewCommand(...): Promise<ReturnType> {
    return this.createWritePromise(createMyNewCommand(...));
}
```

**Python async** (`python/glide-async/python/glide/async_commands/`):
Add the command method to `CoreCommands` (or `StandaloneCommands`/`ClusterCommands` if mode-specific).

**Python sync** (`python/glide-sync/glide_sync/sync_commands/`):
Add the matching sync method to the corresponding command group.

**Java** (`java/client/src/main/java/glide/api/commands/`):
Add to the appropriate command interface and implement in `BaseClient`.

**Go** (`go/internal/interfaces/`):
Add to the appropriate interface and implement in `base_client.go`.

### 5. Add tests

Each language needs tests:
- Unit test for command construction
- Integration test against a real Valkey server
- Cluster mode test if routing matters

Test locations:
- Node.js: `node/tests/`
- Python: `python/tests/`
- Java: `java/client/src/test/java/glide/`
- Go: `go/` (unit tests co-located with source), `go/integTest/` (integration tests)

### 6. Update protobuf definitions

If adding to protobuf (IPC-based languages):
- `glide-core/src/protobuf/command_request.proto` - add to RequestType enum
- Regenerate: protobuf files are auto-generated during build

---

## Reference: build-and-test

# Build and Test

Use when setting up a development environment, running tests, or debugging build issues.

## Prerequisites

- Rust toolchain (rustup)
- Node.js 16+ (for Node.js wrapper)
- Python 3.9+ (for Python wrappers)
- Java 11+ (for Java wrapper)
- Go 1.21+ (for Go wrapper)
- Docker (for integration tests - cluster setup)
- protoc (protobuf compiler)

## Preferred: top-level `Makefile`

The repo root `Makefile` is the canonical way to build and test. It wires each language to its own toolchain.

```bash
make all          # java + python + node + go + all tests + lint
make java         # release build
make python       # python async + sync, release
make node         # release build
make go           # build

make java-test    # integration tests
make python-test
make node-test
make go-test

make java-lint    # spotlessApply
make python-lint
make node-lint
make go-lint
```

Tests that need a server use the `check-valkey-server` Make target which spins up a Valkey process.

## Raw per-stack equivalents

### Rust core

```bash
cd glide-core
cargo build --release
cargo test
cargo clippy
cargo fmt
cargo bench
```

### Node.js

```bash
cd node
npm install
npm run build:release
npm test
```

### Python (async + sync)

Python uses `python3 dev.py` as the canonical build/test/lint driver:

```bash
cd python
python3 dev.py build --mode release
python3 dev.py test
python3 dev.py lint
```

Raw pytest against the installed package also works once `dev.py build` has produced the wheels.

### Java

```bash
cd java
./gradlew :client:buildAllRelease
./gradlew :integTest:test
./gradlew :spotlessApply
```

### Go

```bash
cd go
make build
make test
make lint
```

## Integration tests - cluster setup

`utils/cluster_manager.py` manages the test topology:

```bash
# Standalone Valkey
python3 utils/cluster_manager.py start --cluster-mode false

# 3 primaries + 3 replicas
python3 utils/cluster_manager.py start --cluster-mode true

# Stop
python3 utils/cluster_manager.py stop
```

## Common issues

- **NAPI build fails**: ensure `node-gyp` deps are installed (Python, C++ toolchain)
- **PyO3 build fails**: `maturin` required - `pip install maturin` or let `dev.py` manage the `.env/` virtualenv
- **Protobuf mismatch**: proto files are regenerated at build time; force rebuild if out of sync
- **Socket permission errors**: UDS sockets created in temp dir - name includes `{pid}-{uuid}` to avoid collision. Check temp dir permissions and existing stale socket files if reuse is suspected.
- **Cross-language change**: if you modify `glide-core/` or `ffi/`, rebuild AND test **every** language binding - the core is shared across all wrappers and both FFI modes (UDS and direct FFI).
