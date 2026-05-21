---
name: valkey-review
description: "Use when reviewing a valkey-io/valkey PR. Loads institutional memory that the model would not otherwise have - review comments reviewers keep re-stating, decisions taken but not in the code, recurring bug classes. Redis-baseline and code-visible invariants are assumed. Not for authoring (use valkey-dev)."
version: 0.1.0
argument-hint: "[pr-number]"
---

# Valkey PR Reviewer Skill

Institutional memory for reviewing `valkey-io/valkey` PRs. Redis-baseline knowledge and anything derivable from 5 minutes of reading the surrounding code are assumed. Only divergence, invisible contracts, and recurring reviewer memory live here.

## Operating rules

- Post a comment only with evidence of one of three types: (1) explicit source line range in the PR diff or base tree, (2) a hit from this skill or the KB that names the invariant being violated, (3) a validation test that reproduces the failure.
- Confidence ladder: **high** = all three citation types or two plus an obvious logic break; **medium** = pattern hit plus source lines with a plausible violation; **low** = pattern hit alone, no source confirmation. Post high and medium. Drop low - do not post "this might be".
- Drop classes that reliably generate noise without fixes: style preferences outside `clang-format-18`, suggestions to rename Redis-era identifiers retained for compat (see grep hazards), "consider refactoring", "add a test" without proposing what the test checks, log-string rewording for clarity, doxygen comment requests.
- Redis-baseline is assumed. Do not flag Redis-shaped code. Flag only where Valkey specifically diverges or where a pattern below applies.
- When a pattern's "skip unless" gate does not match the diff, skip the pattern entirely - do not restate it as a generic caution.
- If multiple patterns plausibly apply, the one with the tighter `skip unless` wins. Do not pile on.
- Feedback loop: any human reply or "addressed" signal on your comment is a labeled training signal. Err on the side of one strong comment over three weak ones.

## Always-on checks

Cheap, deterministic, and do not count against the confidence budget - run regardless of diff shape.

- DCO sign-off on every commit (`Signed-off-by:` trailer); missing = CI fail.
- `clang-format-18` exact version; diff-from-format fails CI.
- Any change under `src/commands/*.json` requires a committed regenerated `src/commands.def` (`make commands.def`). Flag if JSON changed and `.def` did not.
- Runtime artifacts staged in the diff: `dump.rdb`, `nodes.conf`, `*.log`, ad-hoc cluster dirs - always a blocker.
- Regression guard: `io_read_state` / `io_write_state` must remain `volatile`, not `_Atomic`. A PR "upgrading" them without redoing the microbenchmark is a regression of the PR 1955 decision.
- `inline` on a function in a `.c` file that is called across translation units is a linker hazard - flag it.
- No emojis in source, comments, logs, or error strings. No doxygen syntax in comments.
- `UNUSED(x)` preferred over `(void)x`. `_Static_assert` over runtime assert for compile-time invariants.
- Never `#include <assert.h>` anywhere - use `serverAssert` / `debugServerAssert` from `serverassert.h`.

## Grep hazards for the reviewer itself

These are Redis-era names retained on purpose. Do **not** file comments asking for a `valkey_*` rename.

- `zmalloc` / `zfree` are `#define`d to `valkey_malloc` / `valkey_free`. Both sides coexisting is the design, not a missed rename.
- `RedisModule_*` is alive via the compat shim `src/redismodule.h` pinned at Redis 7.2.4. New APIs go only in `src/valkeymodule.h`. Do not propose mirroring new APIs into `redismodule.h` (pattern below).
- Replication configs: `slaveof` / `slave-priority` / `masteruser` / `masterauth` remain as aliases for `replicaof` / `replica-priority` / `primaryuser` / `primaryauth`. Many other `slave-*` -> `replica-*` pairs follow. A grep finding the Redis name is an alias hit.
- Client-tracking invalidation channel stays named `__redis__:invalidate`. Renaming breaks every tracking-enabled client. Do not suggest it.
- `dict` is `typedef hashtable dict;` in `src/dict.h`; `src/dict.c` is gone. Callers still using `dict*` / `dictEntry*` (Sentinel, `cluster_legacy.c`, pub/sub patterns, latency, scripting, functions, blocked clients, `subcommands_ht`) are intentional. Do not file "convert to hashtable" unless the PR is that conversion.
- Command struct is `struct serverCommand` and table is `server.commands = hashtableCreate(&commandSetType)`. Not `redisCommand`, not a `dict`.
- Embed-string budget is **128 bytes** via `shouldEmbedStringObject`. `OBJ_ENCODING_EMBSTR_SIZE_LIMIT 44` is gone - do not cite it.
- `events-per-io-thread` and `io-threads-do-reads` are in `deprecated_configs[]`, silently accepted as no-ops. Do not flag code that ignores them.
- `adjustIOThreadsByEventLoad` does not exist in Valkey - real hooks are `IOThreadsBeforeSleep` / `IOThreadsAfterSleep` with Ignition/Cooldown CPU sampling. Do not propose event-count scaling.
- `hash-max-listpack-entries` defaults to **512** (Redis 7.x: 128). Do not flag 512 as wrong.
- "Redis" mentions in `VM_*` function comments and in error strings like `This Redis command is not allowed from script` are preserved intentionally (trademark preservation plus external tooling grep). Do not rename.
- INFO fields `master_*` and `slave_*` retained as aliases. Do not propose removal.

## Iterator-invariant taxonomy

Five UAF / corruption windows around the hashtable. Any diff widening one must close it before the rest of this skill applies. The taxonomy is code-visible but the model will not name all five without this list.

1. **Rehash cursor direction.** `rehash_idx` advances 0 upward. `idx < rehash_idx` has migrated to `tables[1]`; `idx >= rehash_idx` still lives in `tables[0]`. Skip-already-rehashed tests use `<`, not `<=`, not `>`. Inverting compiles, passes unmirrored tests, corrupts silently under rehash. Applies to `findBucket`, `hashtableReplaceReallocatedEntry`, safe-iterator init, `hashtableScan`.
2. **Scan + shrink race.** `hashtableTwoPhasePopDelete` reserves a position at begin; a shrink between begin and finalize invalidates it. Pause auto-shrink across the pair or defer shrink until after finalize. Any new `TwoPhase*` caller must bracket this.
3. **Safe-iterator lifetime.** Safe iterators pause incremental rehash for their lifetime. `hashtableCleanupIterator` MUST unregister from `ht->safe_iterators` before the containing table is freed - canonical UAF path. Any new place a safe iterator outlives its table scope is a bug.
4. **stringRef ownership (hash field entries).** `entryUpdateAsStringRef` points at a caller-owned buffer; if the caller frees or reuses it before the entry is freed or re-updated, the hash read path UAFs. Flag any new call that passes a short-lived buffer.
5. **Two-phase insert reservation.** `hashtableInsertAtPosition` commits what `hashtableFindPositionForInsert` reserved. Any realloc, rehash, shrink, or callback re-entry between them invalidates the reservation. Treat as atomic - no allocations, scans, or callbacks in the window.

## Subsystem patterns

The 34 institutional-memory patterns. Each is gated on its "skip unless" - if the diff does not match, do not invoke the pattern.

### Cluster and replication

#### sds `err` ownership across dual-channel / syncWithPrimary state machines

The diff looks OK but is wrong when: a new state-machine worker returns `C_ERR` without setting `*err`, or the caller frees `err` twice, or leaves `*err` stale on the success path.
Reviewer memory: the unwritten contract is "non-NULL `err` on `C_ERR`, NULL on `C_OK`". Every worker must assign an sds (never `strerror(errno)` into `sds*`), null after freeing, and the signature must be `sds *err` not `char **err`. Callers downstream rely on `sdsfree(err)`.
Cites: PR 945, PR 1476.
Skip unless: the diff touches a worker in `replication.c` that takes `sds *err` or returns into one, or adds/renames a state in the sync-with-primary / dual-channel state machine.

#### Only advance `server.repl_state` on success, never on `C_ERR`

The diff looks OK but is wrong when: a worker function returns `C_ERR` and the driver still assigns `server.repl_state = NEXT_STATE`, or the new state is assigned inside the worker rather than in the switch driver.
Reviewer memory: `cancelReplicationHandshake` takes different cleanup paths based on `server.repl_state`; advancing on error routes to the wrong branch and leaks the partial connection. State transitions belong in the driver after a success check, not inside the worker.
Cites: PR 945, PR 1476.
Skip unless: the diff adds or modifies a `case REPL_STATE_*` inside the sync / dual-channel switch, or moves state assignment out of the driver.

#### Cross-version gating: new cluster-bus / replication features need peer-version checks

The diff looks OK but is wrong when: a new cluster-bus message type, ping extension, or replicated command is sent to peers without checking `replica_version` (REPLCONF VERSION, since 8.0), a `CLUSTER_NODE_*_SUPPORTED` flag, or a dedicated feature flag.
Reviewer memory: `server.replicas` contains legacy 7.2 / 7.0 / 8.0 peers. With `propagation-error-behavior=panic` an unknown command crashes the old replica. Gate must be an explicit version or capability, never "assume everyone is unstable".
Cites: PR 52, PR 879, PR 1091, PR 1384, PR 1708.
Skip unless: the diff introduces a new cluster-bus message type, a new ping extension, a new command propagated to replicas, or short-circuits a behavior on the basis of "all replicas can do X".

#### Light cluster-bus messages before the link is settled

The diff looks OK but is wrong when: the light-packet gate is only `nodeSupportsLightMsgHdrFor*(node) && flags`, without `node->link && node->pong_received >= node->link->ctime`.
Reviewer memory: before pong-receipt the peer has no `link->node`; light headers carry no sender-id, peer can't resolve the sender, frees the link - under pubsub load this becomes a permanent disconnect storm. Fallback when the gate fails is the heavy variant, not drop.
Cites: PR 1572, PR 2227, PR 2817, PR 2840.
Skip unless: the diff adds a new light-header variant, adds a `CLUSTER_NODE_LIGHT_HDR_*_SUPPORTED` flag, or changes the predicate deciding light-vs-heavy at send.

#### Log spam in cluster / replication hot paths

The diff looks OK but is wrong when: `serverLog(LL_NOTICE, ...)` is added inside `clusterCron`, a per-packet handler, or a reconnect loop, without a frequency delay.
Reviewer memory: in 500-node clusters an unguarded log line on cluster-cron or the packet path is hundreds of messages per second - CPU and tail-latency regression, amplified when log-file and config-file share a disk. Wrap in frequency delay or drop.
Cites: PR 1032, PR 1307.
Skip unless: the diff adds a `serverLog` call inside `clusterCron`, `clusterProcessPacket`, a per-packet handler, or any function running once per node per cron iteration.

#### Chain replication is reachable via `CLUSTER REPLICATE`

The diff looks OK but is wrong when: a PSYNC path, assert, or early-return assumes `sender_claimed_primary->replicaof == sender` or "a replica in the same shard must share my replication history".
Reviewer memory: cluster mode does not prevent `CLUSTER REPLICATE <other-replica>` - chains are allowed by deliberate non-decision. PSYNC paths, same-shard asserts, and `replicaof` users must tolerate `replicaof != sender_primary`. Use `shard_id` over `replicaof` chain walks.
Cites: PR 885, PR 1018, PR 1674, PR 2301.
Skip unless: the diff adds an assert or early-return whose condition is "replica's `replicaof` equals its shard's primary", or uses `replicaof` chain walks where `shard_id` would serve.

#### Broadcasting FAIL from a replica on receipt of a FAIL

The diff looks OK but is wrong when: a FAIL-packet receive handler calls `clusterSendFail(node->name)` so "everyone hears it".
Reviewer memory: if every replica re-broadcasts on receipt, an N-node cluster with M replicas per shard produces O(M*N) FAIL messages. The legitimate "all primaries vote" use case is solved with `CLUSTERMSG_FLAG0_FORCEACK` on AUTH_REQ, sometimes guarded by `replication-offset != 0` for newly-connected replicas. Only the original detector broadcasts.
Cites: PR 2209, PR 2227.
Skip unless: the diff adds `clusterSendFail` / `clusterBroadcastFail` outside the single site that first flips `CLUSTER_NODE_FAIL`, or removes a guard around an existing one.

### Data and memory

#### Key ownership flipped by embedded entries

The diff looks OK but is wrong when: embedded-key or embedded-value support is added to a `dictType` / `hashtableType` and existing `dictAddRaw` / `hashtableAdd` / `kvstoreDictAddRaw` / `dbAddInternal` / `dbAddRDBLoad` / `setExpire` callers are left alone.
Reviewer memory: turning on embedded entries flips `Add*` from "takes ownership of the sds key" to "copies and leaves caller to free". The "consumed" return code (1 = inserted or freed, caller must not free) must be re-verified at every caller. The `dbAddRDBLoad` comment still says "retained by the function" even after semantics diverged - trust the type, not the comment.
Cites: PR 541, PR 1281, PR 3366.
Skip unless: the PR touches a `dictType` / `hashtableType` definition, changes an `Add*` / `Set*` signature in `dict.c` / `hashtable.c` / `kvstore.c`, or introduces a new caller of `*AddRaw`.

#### Entry pointer-tag encoding is not self-describing

The diff looks OK but is wrong when: code uses the 3-bit `ENTRY_*_MASK` or an `entryIsX` helper assuming the header comments match the implementation, or adds a new tag bit against the stale table.
Reviewer memory: the scheme is "last bit 1 = key (ignore other tag bits), last bit 0 = entry with 2 more kind bits". The `#define` comments are wrong; `entryIsKey` must be explicitly excluded in predicates like `entryIsNoValue`. The opaque-accessor proposal was declined on perf grounds - that decision is not in the code.
Cites: PR 541, PR 749, PR 3366.
Skip unless: the PR adds a new entry encoding / tag bit, changes a predicate like `entryIsNormal` / `entryIsKey` / `entryIsNoValue`, or casts a raw `dictEntry*` / `entry*` through `void*` to a concrete type.

#### Functional code inside `serverAssert`, or bare C `assert`

The diff looks OK but is wrong when: a call with an effect the program depends on is placed inside `serverAssert(...)`, or `assert(` from `<assert.h>` is used anywhere.
Reviewer memory: Valkey does not use generic C `assert`. Even though `serverAssert` is not currently stripped in release, the policy treats it as debug-only - side-effect expressions inside an assert are rejected on sight.
Cites: PR 1502, PR 2432, PR 2472.
Skip unless: the PR introduces `assert(` (no `server` prefix), or places a function call that mutates state or whose return value the program depends on inside any assert macro.

#### `emptyDB` flags, `RDB_INCOMPATIBLE`, replication-info restore across RDB entry points

The diff looks OK but is wrong when: a new or modified RDB-load path calls `emptyDB(EMPTYDB_NO_FLAGS)`, treats `rdbLoad*` as returning only `C_OK` / `C_ERR`, or unconditionally calls `replicationCachePrimaryUsingMyself`.
Reviewer memory: `emptyDB` must respect `lazyfree_lazy_user_flush`; `rdbLoad` / `rdbLoadRio` can return `RDB_INCOMPATIBLE` which must be propagated distinct from `RDB_FAILED`; `debug loadaof` on an existing replica must skip replication-info restore (overwriting `server.primary` releases the cached primary). A failed load must not leave the DB flushed.
Cites: PR 1173, PR 2366, PR 2600.
Skip unless: the PR touches an `emptyDB(...)` call, an `rdbLoad*` caller (`replicaLoadPrimaryRDBFromSocket`, `rdbLoad`, `rdbLoadRio`, `VM_RdbLoad`, `debug.c`, `loadSingleAppendOnlyFile`), replication-info restoration, or adds a new RDB entry point.

#### TTL / expiry divergence on passive-expiry-via-overwrite

The diff looks OK but is wrong when: a write command (HSET, HINCRBY, HSETEX KEEPTTL, MSETEX, SET with expire) overwrites an already-expired field / key on primary without propagating explicit HDEL / DEL, relying on replica parallel expiry.
Reviewer memory: `checkAlreadyExpired` always returns false on replica. Primary must send explicit HDEL / DEL for expired-but-unreclaimed fields before the user write. Rewriting argv to a bare DEL is legal for single-key commands (SET) but breaks for multi-key commands where some keys are still live. Per-command analysis required; "lazy expiry on replica" is intentionally not implemented.
Cites: PR 2944, PR 3060, PR 3121.
Skip unless: the PR adds or modifies a write command that can overwrite an expired value / field, touches `deleteExpiredKeyAndPropagate*`, or changes `checkAlreadyExpired`.

#### `mustObeyClient` must cover all four replicated-in sources

The diff looks OK but is wrong when: a write-path gate checks `c->flag.primary` alone, or a `LOADING` / OOM / `maxmemory` check lets AOF-load, slot-migration-import, or `import-mode` clients through by accident (or blocks them incorrectly).
Reviewer memory: four distinct replicated-in sources - primary client, AOF-load (`CLIENT_ID_AOF`), slot-migration-import job, `import-mode` / `import_source` clients. `mustObeyClient` is the single source of truth; check it rather than enumerating flags. `import_source` enforcement via config-file comment alone is wrong - it must be a `LOADING` error.
Cites: PR 1185, PR 2944, PR 3004.
Skip unless: the PR adds a new check that rejects a client based on state (OOM, LOADING, read-only, cluster), or introduces a new `c->flag.*` gate on a write path.

#### Keyspace-notification and `addReply` ordering

The diff looks OK but is wrong when: a command calls `addReply*` then `notifyKeyspaceEvent`, or reorders `signalModifiedKey` relative to `dbDelete`.
Reviewer memory: notifications must fire before any `addReply*` so module KSN subscribers (search, client-tracking, WATCH) see a pre-reply world. No assert exists - proposed and dropped for perf. The `initDeferredReplyBuffer` optimization makes notify-before-reply cheap for no-subscriber workloads; skipping it regresses perf. The `signalModifiedKey` vs `dbDelete` ordering is deliberately undocumented - changing it reshuffles what modules observe on re-read but is not a bug per se.
Cites: PR 1819, PR 3144.
Skip unless: the PR reorders `notifyKeyspaceEvent` / `addReply*` / `signalModifiedKey` / `dbDelete` within a command, or adds a new command that mutates a key and replies.

#### `dismissMemory` / `madvise` exception list for small allocations

The diff looks OK but is wrong when: a small allocation gets `dismissMemory(ptr, size)` expecting CoW benefit, or a dismiss call is removed on the grounds that the allocation is small.
Reviewer memory: dismiss via `madvise` only when `size >= page`; free via allocator when size is known. sds is in the club because `sdsAllocSize` is cheap; listpack is NOT - `lpBytes` returns logical size, not allocation size. Skiplist nodes get `dismissMemory(zn, 0)` - size-hint 0 lets the allocator decide. Removing dismiss on skiplist paths regresses users with large strings in sorted sets.
Cites: PR 905, PR 2508.
Skip unless: the PR adds or removes a `dismissMemory` call, changes fork / CoW handling for sds / listpack / skiplist / zset nodes, or reworks `dismissObject`.

### Modules and scripting

#### Module API struct versioning

The diff looks OK but is wrong when: a new struct is added to `valkeymodule.h` without a leading `version` / `abi_version` field, or server code reads `engine->impl.methods.new_field` unconditionally after an ABI bump.
Reviewer memory: every non-opaque struct exposed in `valkeymodule.h` needs a leading version field; server-side reads of fields added in later versions must be gated on `version >= N`. Guarantee is bidirectional: a module built against Valkey 10 must run on Valkey 9 and vice versa. Templates: `ValkeyModuleClientInfo`, `VALKEYMODULE_SCRIPTING_ENGINE_ABI_VERSION`.
Cites: PR 1277, PR 1701, PR 1826, PR 1984, PR 2237, PR 3122.
Skip unless: the PR changes `valkeymodule.h` structs, enum values, adds / reorders fields in an exposed callback struct, or reads a field from one of these structs in server code.

#### Do not add functions to `redismodule.h`

The diff looks OK but is wrong when: a new `ValkeyModule_Foo` declaration is mirrored into both `valkeymodule.h` and `redismodule.h`, or a new API lands only in `redismodule.h`.
Reviewer memory: `redismodule.h` is frozen at Redis 7.2.4 - existence is purely so pre-fork Redis modules keep compiling. New APIs go in `valkeymodule.h` only. Fix is deletion, not rename.
Cites: PR 1041, PR 1546.
Skip unless: the PR touches `src/redismodule.h` with anything other than a pure removal or comment edit.

#### `VM_*` comments are the published API docs

The diff looks OK but is wrong when: a new `VM_Foo` ships with a terse or missing top comment, an existing comment is compressed, or "Redis" mentions are mechanically renamed to "Valkey".
Reviewer memory: comments above `VM_` functions feed `utils/generate-module-api-doc.rb` into `valkey.io/topics/modules-api-ref`. Missing or malformed markdown drops the function from the docs. "since Redis X.Y" notes must be preserved; "Redis OSS" is the trademark form.
Cites: PR 223, PR 433, PR 1041, PR 1489, PR 2522.
Skip unless: the PR adds / removes / renames a `VM_*` function, edits the comment block directly above one, or renames "Redis" to "Valkey" in `module.c` / `valkeymodule.h` comments.

#### Log strings and error-reply shapes are observable interfaces

The diff looks OK but is wrong when: a log message is reworded, a previously-succeeding API grows a new error reply, or a new top-level error prefix is introduced that collides with an existing one (`BUSY`, `NOSCRIPT`).
Reviewer memory: operators grep logs for exact historical strings; clients parse error prefixes. `BUSY` already means "script running" - reusing it for a module-unload error is a silent breaker. New failure modes on previously-OK paths must be called out in the PR description.
Cites: PR 226, PR 3469.
Skip unless: the PR changes the text of a `serverLog` / `addReplyError` string, adds a new error-return path to an API that previously returned OK, or introduces a new top-level error prefix.

#### `dlopen` flags: gate on libc, not OS

The diff looks OK but is wrong when: `#ifdef __linux__` guards use of `RTLD_DEEPBIND` (or similar GLIBC-only dlopen flag), or `#if !defined(__APPLE__)` is used to infer Linux.
Reviewer memory: the flag is a libc feature. Correct guard is `__GLIBC__` (add `__FreeBSD__` explicitly if supported). Illumos, OpenBSD, NetBSD, Dragonfly do not have `RTLD_DEEPBIND`; `!defined(__APPLE__)` silently breaks all of them. Use allowlists, not OS denylists.
Cites: PR 1703, PR 1707.
Skip unless: the PR adds or modifies a platform guard around `dlopen` / `dlsym` / `dlmopen`, or introduces any new `#ifdef __linux__` around a libc feature.

### Net, event-loop, server-core

#### Do not pierce the `ConnectionType` abstraction

The diff looks OK but is wrong when: `if (connIsTLS(c->conn))` or `if (conn->type == CT_RDMA)` appears in generic networking / cluster / TLS code, or TLS/TCP-only fields (addr, peer username, KeepAlive, is_closing) are stashed on `struct connection`.
Reviewer memory: add a callback to `ConnectionType` returning NULL / no-op for types that don't implement it; route generic code through `connXxx()` wrappers. Bare `extern` of a `tls.c` symbol from a `.c` file, or `conn->type->foo` access, is a review blocker. The callback pattern keeps getting re-proposed and authors keep reaching for the inline branch.
Cites: PR 837, PR 1338, PR 1706, PR 1920, PR 2070, PR 2202, PR 2815, PR 3469.
Skip unless: the PR adds type-specific branching in generic networking / cluster / TLS code, or adds a field to `struct connection` that only some transports use.

#### `createCachedResponseClient` misses TLS / IP-family / hide-user-data context

The diff looks OK but is wrong when: a cached CLUSTER SLOTS / CLUSTER NODES / HELLO response is served to a real client after being generated by a cached-response fake client keyed only on RESP version, or `connIsTLS(c->conn)` is checked on such a client.
Reviewer memory: the fake client is constructed with RESP version alone; downstream generators read `shouldReturnTlsInfo()` / peer IP family from `server.current_client`. Caching by RESP alone silently returns wrong ports / addresses. Crash path: EVAL-over-TLS calling CLUSTER SLOTS against a non-TLS cached response.
Cites: PR 1063, PR 2839.
Skip unless: the PR introduces a new cached-response consumer or changes the cache key for an existing one (verify by grepping `shouldReturnTlsInfo`, `connIsTLS`, IP-family checks in the generator).

#### Fake-client detection and `current_client` fallback

The diff looks OK but is wrong when: a networking helper checks `c->conn == NULL` or `conn->type` to decide "is this real?", and falls back to `server.current_client` when `c` looks fake.
Reviewer memory: four fake-client shapes (AOF `CLIENT_ID_AOF`, Lua / function script client, module client, cached-response client) do not share one flag. Implicit fallback to `current_client` answers a question the caller didn't ask and breaks in script / recursive paths where `current_client != executing_client`. Require the caller to say which one it wants.
Cites: PR 53, PR 1063, PR 3182.
Skip unless: the PR adds or modifies code that branches on "is this a real client?", or reaches for `server.current_client` as a default when the passed `client *` is unsuitable.

#### `c->flags` is not IO-thread safe

The diff looks OK but is wrong when: a `c->flag.xxx` bit is set or read in IO-thread code (parser, TLS negotiation offload, write offload, ACL / auto-auth from cert), or `ClientFlags` widens past 64 bits.
Reviewer memory: `c->flag` is main-thread owned. IO-thread-produced / consumed state must go through `c->read_flags` (guarded by `io_read_state`) or `c->write_flags` (guarded by `io_write_state`). `ClientFlags` is 64 bits today; a 65th silently grows the client by 8 bytes - reviewers ask for `static_assert(sizeof(ClientFlags) <= 16)`. Do not "upgrade" `io_*_state` from `volatile` to `_Atomic` (PR 1955 perf decision).
Cites: PR 490, PR 1920, PR 1955, PR 3020, PR 3086, PR 3122, PR 3306.
Skip unless: the PR adds a new `c->flag` bit, accesses an existing one from code that runs on an IO thread, or changes the declaration of `io_read_state` / `io_write_state`.

#### Do not log user-controlled / sensitive strings via `serverLog`

The diff looks OK but is wrong when: a `serverLog(LL_WARNING, "...%s...", user_string)` is added for query buffer, username from TLS cert, key name, module log message, or failed-auth details.
Reviewer memory: three rules. (1) user data respects `server.hide_user_data_from_log`, prints `*redacted*` otherwise; (2) failed authentication goes to the ACL log via `addACLLogEntry` with a typed reason, not `serverLog` - ACL log is structured, survives hide-user-data, carries IP / context; (3) WARNING means "operator must act" - a missing optional cert or a bad user command is not WARNING.
Cites: PR 1889, PR 1920, PR 2913, PR 3078, PR 3471.
Skip unless: the PR adds a new `serverLog` with a `%s` or user-derived format, or adds a new log call on an auth / ACL / TLS-cert code path.

#### INFO metrics: store the source, not the derived value

The diff looks OK but is wrong when: a cron handler computes a user-visible derived value (`tls_*_expires_in_seconds`, a rolling average, a "current snapshot" of a cumulative counter) and writes it into a `server.*` field that INFO reads directly.
Reviewer memory: store the source (expiration timestamp, numerator and denominator, cumulative counters) and compute the derived view at INFO time. Cron-written averages are wrong between ticks, countdown timers drift. INFO field names are public contract - new fields need a subsystem prefix (`acl_*`, not a bare magic string) and must be wired into `genValkeyInfoStringACLStats` / equivalent.
Cites: PR 861, PR 1920, PR 2309, PR 2913.
Skip unless: the PR adds a new INFO field, caches a computed value for INFO, or renames an existing INFO field.

#### `addReply*` / `prepareClientToWrite` ordering

The diff looks OK but is wrong when: replies are produced before the client is transitioned to blocked / pending, or an early-return check is added high in `prepareClientToWrite` above the `CLIENT_CLOSE_ASAP` / `CLIENT REPLY OFF` / already-installed-write-handler checks.
Reviewer memory: `addReply*` always calls `prepareClientToWrite`, so any new early-return must sit just above `putClientInPendingWriteQueue`, not at the top - otherwise you silently skip close-asap / reply-off / pipelined-write handling. Replies generated before full transition to blocked land in the wrong buffer. `writePreparedClient` is NOT type-safe (still cast-compatible) - it was weakened on purpose.
Cites: PR 860, PR 1119, PR 1819.
Skip unless: the PR touches `prepareClientToWrite`, `addReply*` ordering around blocked / unblocked transitions, or `writePreparedClient`.

#### `ProcessingEventsWhileBlocked` accounting landmine

The diff looks OK but is wrong when: new per-cycle work is added to `beforeSleep`, `serverCron`, IO-thread batch processing, or an INFO counter without special-casing the recursive invocation from RDB / AOF load, full-sync `-LOADING` replies, or slow-script / module `SCRIPT KILL`.
Reviewer memory: `ProcessingEventsWhileBlocked` runs a cut-down loop where `server.el_start` is not set, `clients_pending_read` may be partially drained, and the outer iteration is still "active". New work must be skipped when the flag is true, or accounted under an explicit guard. Command batching and prefetching especially cannot run recursively - global batch state clobbers.
Cites: PR 861, PR 2931.
Skip unless: the PR adds work to `beforeSleep` / `serverCron` / IO-thread batch init, adds a new INFO counter driven by cron, or runs code reachable from `processEventsWhileBlocked`.

### Test, build, other

#### Never modify files under `deps/`

The diff looks OK but is wrong when: `deps/hiredis/*`, `deps/linenoise/*`, `deps/fast_float/*` (or similar vendored trees) are edited for a local fix, Redis->Valkey rename, or build-option wiring.
Reviewer memory: `deps/` is vendored; hiredis is compiled independently and linked. Patches conflict with every future re-import. Fix upstream and re-vendor, or wrap from `src/`. Glue code for C++ deps like `fast_float` belongs in `src/`, not in the vendored tree.
Cites: PR 223, PR 389, PR 443, PR 1260.
Skip unless: the PR actually edits files under `deps/**`.

#### Low-level libraries must not include `server.h`

The diff looks OK but is wrong when: `adlist.c`, `sds.c`, `hashset.c`, `anet.c`, `crccombine.c` (or other building-block files) grow `#include "server.h"` just to get `assert` / `serverAssert` / page size / one global.
Reviewer memory: include `serverassert.h` instead. Datastructures and `anet` / `sds` are used by `valkey-cli` and `valkey-benchmark`; the layering is one-way from server onto these libs, never the reverse. `server.h` makes everything depend on everything. The name `serverassert.h` is misleading (not server-specific) which is why authors reach for `server.h`.
Cites: PR 763, PR 1176, PR 1800, PR 1811, PR 2096, PR 3469.
Skip unless: the changed file is a low-level building block (sds, adlist, hashset, anet, connection/ae, zmalloc, a standalone util) or anything also linked into `valkey-cli` / `valkey-benchmark`. Files inside the server proper (`server.c`, `networking.c`, `db.c`, `replication.c`, `cluster*.c`, `t_*.c`) are exempt.

#### CPU-feature dispatch: IFUNC, never static-initialized `__builtin_cpu_supports`

The diff looks OK but is wrong when: a new SIMD path guards with `static int cpu_supports_avx2 = __builtin_cpu_supports("avx2");` or a `__attribute__((constructor))` that fills a function pointer.
Reviewer memory: (1) `__builtin_cpu_supports` is not a constant expression in C, so the `static` initializer fails to compile - works only in C++. (2) Even with a constructor-written function pointer, the indirect call costs measurably on hot paths. Use GNU IFUNC resolver (template: `string2ll_resolver`, PR 2099) for direct-call PLT entry. For backport-sized fixes, a plain `if (__builtin_cpu_supports(...))` at each call site is the accepted compromise.
Cites: PR 1944, PR 2099, PR 2571, PR 3585.
Skip unless: the PR adds a new CPU-dispatch path, or removes / weakens the `__builtin_cpu_supports` runtime check in existing code.

#### Tcl tests: `wait_for_condition` / `wait_for_*` over fixed sleeps

The diff looks OK but is wrong when: a new or modified test uses `after 1000`, a fixed `debug sleep N`, or hand-rolled `for {} {} {}` polling, and asserts a tight range like `assert_range $x 450 650`.
Reviewer memory: fixed waits are flaky under Valgrind. Use `wait_for_condition`, `wait_for_sync`, `wait_for_blocked_client`, `wait_for_cluster_propagation`, `wait_for_log_messages` (`tests/support/util.tcl`). `wait_for_sync` alone is not always enough - check `repl_state` for `wait_bgsave`. Ranges are OK only if the upper bound accommodates Valgrind; if you widen one bound, widen the matching one too. Preferred delay / retries ~100ms x 50.
Cites: PR 52, PR 917, PR 1784, PR 2095, PR 2748, PR 2934, PR 2953, PR 3069, PR 3265.
Skip unless: the test introduces or retains a hardcoded sleep / fixed-timeout / tight numeric range as synchronization; skip if already using `wait_for_*`.

#### Tcl tests: `pause_process` / `resume_process` over `debug sleep`

The diff looks OK but is wrong when: a test uses `r debug sleep N` (or a `bg_server_sleep.tcl` helper) to simulate an unresponsive node, or the pause lives above the `test {}` block.
Reviewer memory: `debug sleep` freezes the server completely - use `pause_process $pid` + `resume_process $pid` instead. It is not flaky and does not artificially extend test time. Place the pause inside the `test {}` block so `--only` selection still works.
Cites: PR 804, PR 861, PR 1910, PR 3091.
Skip unless: the test actually uses `debug sleep` or an equivalent self-blocking helper to freeze a peer.

#### Cluster / external-CI skip tags

The diff looks OK but is wrong when: a new test uses nested `start_server`, runs `SLAVEOF` / `REPLICAOF`, uses two keys without a shared `{hashtag}`, or relies on `--other-server-path`, but declares unrelated or missing tags.
Reviewer memory: tag by the reason that matches. `external:skip` when the test spins its own servers (external CI uses one pre-existing server, nested `start_server` fails). `cluster:skip` when the test uses cross-slot keys or cluster-banned commands (SLAVEOF, multi-db). `needs:other-server` when a second binary is supplied via `--other-server-path`. For cross-slot keys the preferred fix is renaming to `{t}hash1` / `{t}hash2` for colocation, not skipping. `reply-schemas-validator` runs with `--force-resp3 --log-req-res` - RESP2-specific tests need `logreqres:skip` because it rewrites `HELLO 2` to `HELLO 3`.
Cites: PR 526, PR 1487, PR 1572, PR 1819, PR 2366, PR 2793, PR 3003.
Skip unless: the PR adds or moves a `test {}` / `start_server {}` block and starts nested servers, uses cross-slot keys or cluster-forbidden commands, depends on `--other-server-path`, or tests RESP2-specific protocol details.
