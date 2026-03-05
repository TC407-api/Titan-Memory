# Titan Memory v2.1 — Full Audit Report

**Date:** March 4, 2026
**Auditor:** Claude Opus 4.6 (7 parallel audit agents)
**Codebase:** 31,890 LOC TypeScript, 107 modules, 1,008 tests passing
**Checkpoint:** `pre-audit-checkpoint` at commit `6736560`

---

## Executive Summary

Titan Memory v2.1 is a functionally solid cognitive memory server with strong TypeScript foundations (`strict: true`, zero implicit `any`), comprehensive MCP tool coverage (30/30 documented), and a clean build pipeline. However, this audit identified **62 findings** across 7 categories that range from security vulnerabilities to architectural debt.

### Health Score: **68/100** (Good foundation, significant improvement opportunities)

| Category | Score | Status |
|----------|-------|--------|
| Code Quality | 6/10 | God class (2,330 LOC), 25 functions exceed 30-line limit |
| Type Safety | 8/10 | `strict: true` enabled, only 13 unsafe casts |
| Security | 5/10 | 3 HIGH CVEs, timing-unsafe token comparison, no rate limiting |
| Performance | 5/10 | N+1 sidecar calls (critical), unbounded caches, 2x reranker cost |
| Testing | 5/10 | 63.5% coverage (below 70% threshold), 23/30 tools untested |
| Dependencies | 6/10 | 3 HIGH vulns, eslint missing, ghost deps |
| Documentation | 7/10 | All tools documented, but benchmark numbers inaccurate |

### Key Numbers

- **3** critical security vulnerabilities (MCP SDK data leak, Hono auth bypass, minimatch ReDoS)
- **25** functions exceeding 30-line limit
- **13** unsafe type casts (`as any` / `as unknown`)
- **63.5%** statement coverage (below 70% threshold on all 4 axes)
- **50+** sequential HTTP calls per recall (N+1 sidecar pattern)
- **2x** unnecessary Voyage reranker token cost per recall
- **0%** test coverage on compression, LLM turbo, and benchmark subsystems

---

## CRITICAL Issues (3)

### C-01: MCP SDK Cross-Client Data Leak (CVE)

- **Severity:** CRITICAL
- **Location:** `package.json` — `@modelcontextprotocol/sdk` v1.25.2
- **Problem:** Versions 1.10.0–1.25.3 allow shared server/transport instance reuse to leak data between clients. Advisory: GHSA-345p-7cg4-v4c7.
- **Fix:** `npm install @modelcontextprotocol/sdk@1.27.0`
- **Effort:** S (5 minutes)
- **Impact:** Data isolation between MCP clients

### C-02: N+1 HTTP Calls to Sidecar Per Sentence

- **Severity:** CRITICAL (Performance)
- **Location:** `src/cortex/pipeline.ts:126-136`
- **Problem:** Each sentence in every recalled memory triggers a separate HTTP POST to `localhost:8079/highlight`. With 10 memories averaging 5 sentences each, that's 50 sequential HTTP requests adding 1-5 seconds to every recall. The sidecar already does its own sentence splitting internally.
- **Fix:** Batch all sentences into a single sidecar call per memory, or pass full memory content (1 call per memory instead of 1 per sentence).
- **Effort:** M (2-4 hours)
- **Impact:** Recall latency reduction from 800-3000ms to 300-800ms

### C-03: Timing-Unsafe Token Comparison

- **Severity:** CRITICAL (Security)
- **Location:** `src/utils/auth.ts:59,68`
- **Problem:** `validateDashboardToken` and `validateA2AToken` use `Array.includes()` for token comparison, which is not constant-time. Enables timing side-channel attacks to guess valid tokens.
- **Fix:** Replace with `crypto.timingSafeEqual()` wrapped in a helper that handles length mismatches.
- **Effort:** S (30 minutes)
- **Impact:** Prevents token guessing attacks

---

## HIGH Priority Issues (12)

### H-01: Hono Node Server Authorization Bypass (CVE)

- **Location:** Transitive dep via `@modelcontextprotocol/sdk`
- **Problem:** Encoded slashes in static paths bypass protected route middleware. Advisory: GHSA-wc8c-qw6v-h7f6.
- **Fix:** `npm audit fix`
- **Effort:** S

### H-02: minimatch ReDoS (3 advisories)

- **Location:** Transitive dependency, `<=3.1.3`
- **Problem:** Repeated wildcard patterns cause catastrophic backtracking. Advisories: GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74.
- **Fix:** `npm audit fix`
- **Effort:** S

### H-03: `titan.ts` God Class (2,330 LOC)

- **Location:** `src/titan.ts`
- **Problem:** Single class holds 23 private subsystem fields, ~80 public methods across 12 logical groups. Any change to a Phase 3 subsystem touches the same file as a working memory bug fix.
- **Fix:** Extract into 7 manager classes:
  - `MemoryCRUDManager` — add, recall, get, delete, flush, curate
  - `MemoryAdminManager` — stats, prune, feedback, export
  - `Phase3CognitiveManager` — knowledge graph, decisions, world model, validation
  - `MirasManager` — suggest, highlight, patterns, context capture
  - `CortexManager` — classify, summarize, sufficiency, intent
  - `CausalGraphFacade` — link, trace, explain
  - `WorkingMemoryFacade` — focus, scratchpad
- **Effort:** L (2-3 days incremental)
- **Impact:** Maintainability, testability, cognitive load

### H-04: Localhost Auth Bypass Enabled by Default

- **Location:** `src/utils/auth.ts:22,26` and `src/mcp/http-server.ts:104`
- **Problem:** Auth disabled entirely when `NODE_ENV !== 'production'`. Any process on the machine gets full access. `allowLocalhostWithoutAuth: true` is the default.
- **Fix:** Default `allowLocalhostWithoutAuth` to `false`. Separate "auth disabled" from "localhost bypass." Remote callers should always require a token.
- **Effort:** M (1-2 hours)

### H-05: `as any` Casts Skip Input Validation

- **Location:** `src/dashboard/api.ts:145,168`
- **Problem:** `req.query.type` and `body.type` (user-controlled strings) are cast directly to `DecisionType` via `as any` with no runtime validation. Invalid values corrupt the decision store's type index.
- **Fix:** Add Zod validation: `z.nativeEnum(DecisionType).safeParse(type)` before passing to `queryDecisions`/`traceDecision`.
- **Effort:** S (30 minutes)

### H-06: Coverage Below Threshold (63.5% vs 70%)

- **Location:** All source files
- **Problem:** Global coverage fails on all 4 axes: Statements 63.56%, Branches 46.71%, Functions 59.87%, Lines 64.81%. Entire subsystems at 0% (compression, LLM turbo, benchmarks). Only 7 of 30 MCP tools tested at runtime.
- **Fix:** Priority test additions (see Testing section below)
- **Effort:** L (3-5 days)

### H-07: Voyage Reranker Gets 2x Needed Documents

- **Location:** `src/layers/longterm.ts:171,179`
- **Problem:** Queries Zilliz with `limit * 2`, sends all results to Voyage reranker without passing `topN`. Doubles reranker API cost and latency on every recall.
- **Fix:** Pass `topN: limit` to `rerank()` — the parameter is already wired in `voyage-reranker.ts:70-72`.
- **Effort:** S (15 minutes)

### H-08: `handleToolCall` is 418 Lines

- **Location:** `src/mcp/tools.ts:615-1022`
- **Problem:** Single method handling 30 tool cases with inline business logic. 14x over 30-line limit.
- **Fix:** Extract each tool handler to a separate function or use a handler registry pattern.
- **Effort:** M (4-6 hours)

### H-09: ESLint Not Installed

- **Location:** `package.json` line 18
- **Problem:** `"lint": "eslint src --ext .ts"` declared but eslint not in dependencies. No linting has been enforced on any commit.
- **Fix:** `npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser` + create `.eslintrc.json`
- **Effort:** M (1-2 hours)

### H-10: Benchmark Numbers in README Don't Match Data

- **Location:** `README.md` lines 363-428
- **Problem:** README claims 90.7/100 (LLM mode) and 84.2/100 (zero-LLM). Latest benchmark data file shows overall mean of 33.39/100. Core retrieval/accuracy tests return 0.0 — only latency and compression pass.
- **Fix:** Either fix the benchmark suite or update README with accurate numbers and honest disclosure of the regression.
- **Effort:** M (investigation needed to determine if benchmarks or claims are wrong)

### H-11: Hidden Zilliz Query on Every Store

- **Location:** `src/layers/longterm.ts:88`
- **Problem:** `store()` calls `getRecentMemories(50)` for surprise scoring on every write. At 10-80ms RTT per query, this adds hidden latency to every `add()` call. Writing to 2 layers doubles this.
- **Fix:** Use in-memory rolling window of last 50 content strings (the circular buffer pattern already exists in this class).
- **Effort:** M (2-3 hours)

### H-12: Dashboard WebSocket Has No Authentication

- **Location:** `src/dashboard/websocket.ts:26-28`
- **Problem:** `/ws` endpoint accepts all connections without token validation. Any process can subscribe to real-time memory events.
- **Fix:** Validate `X-Titan-Token` header during WebSocket upgrade handshake.
- **Effort:** S (1 hour)

---

## MEDIUM Priority Issues (20)

### Architecture & Code Quality

| # | Issue | Location | Fix | Effort |
|---|-------|----------|-----|--------|
| M-01 | `recall()` is 146 lines (5x limit) | `titan.ts:685-830` | Extract `applyLLMRerank()`, `applyAdaptiveReorder()`, `buildRecallResult()` | M |
| M-02 | `add()` is 96 lines (3x limit) | `titan.ts:493-588` | Extract `routeToLayers()`, `classifyAndStore()` | M |
| M-03 | `handleLockRequest()` 4-level nesting | `a2a/server.ts:467-584` | Extract `grantSharedLock()`, `denyWithQueue()` helpers | S |
| M-04 | `checkForConflicts()` 5-level nesting | `a2a/server.ts:762-829` | Extract `detectAndNotifyConflict()`, `scheduleWriteCleanup()` | S |
| M-05 | `createCluster()` O(n^2) centrality | `adaptive-memory.ts:738-800` | Extract `calculateCentrality(memory, others)` | S |
| M-06 | `handleRegister()` 68 lines | `a2a/server.ts:290-358` | Extract agent construction and token generation | S |
| M-07 | Stale `dist/catbrain/` artifact | `dist/catbrain/` | Add `rimraf dist/` to build script before `tsc` | S |

### Type Safety

| # | Issue | Location | Fix | Effort |
|---|-------|----------|-----|--------|
| M-08 | `null as unknown as VerifiedToken` (2 sites) | `auth/middleware.ts:87`, `http-server.ts:152` | Make `AuthenticatedRequest.auth.token` optional: `token?: VerifiedToken` | S |
| M-09 | 5x `as unknown as Record<string, unknown>` | `cortex/extractors.ts:25-33` | Change `CategoryExtraction.fields` to discriminated union in `cortex/types.ts` | M |
| M-10 | 3x `as unknown as Record<string, unknown>` | `validation/behavioral-validator.ts:377,409,423` | Type `ValidationIssue.details` as `Record<string, unknown>` directly | S |
| M-11 | 5 Zod/TypeScript schema mismatches | `mcp/tools.ts` (multiple) | Use `z.nativeEnum(MemoryLayer)` instead of `z.number().min().max()`, use `z.infer<>` | M |
| M-12 | Missing `noUncheckedIndexedAccess` | `tsconfig.json` | Add `"noUncheckedIndexedAccess": true` | M |

### Performance

| # | Issue | Location | Fix | Effort |
|---|-------|----------|-----|--------|
| M-13 | Sequential `recordAccess()` N times | `titan.ts:730-733` | Use `Promise.all()` or batch into single disk write | S |
| M-14 | `LongTerm.memoryCache` unbounded growth | `layers/longterm.ts:303` | Add LRU eviction (reuse `CachedEmbeddingGenerator` pattern), cap at 1,000 | S |
| M-15 | Sentence splitting not cached | `cortex/pipeline.ts:236`, `semantic-highlight.ts:34` | Shared utility + per-recall cache by content hash | S |
| M-16 | `maxMemoriesPerLayer` unenforced | `utils/config.ts:24` | Add capacity check before `store()` in FactualLayer/SemanticLayer with auto-eviction | M |

### Security

| # | Issue | Location | Fix | Effort |
|---|-------|----------|-----|--------|
| M-17 | No rate limiting on any endpoint | `http-server.ts`, `dashboard/server.ts` | Add `express-rate-limit` middleware | S |
| M-18 | No request body size limit on dashboard | `dashboard/server.ts:269-281` | Cap `parseBody` at 1MB | S |
| M-19 | Sidecar communication has no auth | `semantic-highlight.ts:24` | Add shared secret header via env var | S |
| M-20 | A2A token passed in query string | `a2a/server.ts:122` | Prefer header-based token passing, document risk | S |

---

## LOW Priority Issues (27)

### Code Quality (7)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| L-01 | `initializeMirasEnhancements()` 53 lines | `titan.ts:217-269` | S |
| L-02 | `initializeCortex()` 53 lines with nested try/catch | `titan.ts:274-326` | S |
| L-03 | `processPostStore()` 45 lines, single blanket catch | `titan.ts:593-637` | S |
| L-04 | `releaseLock()` O(n) lock lookup | `a2a/server.ts:616-663` | S |
| L-05 | `loadFromDisk()` 45 lines, no shared deserialization | `adaptive-memory.ts:183-227` | S |
| L-06 | `gateStore()` regex re-compiled on every call | `titan.ts:460-472` | S |
| L-07 | `updateContextWindow()` O(n log n) sort on every access | `adaptive-memory.ts:643-677` | M |

### Type Safety (5)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| L-08 | `a2a/client.ts:206` double cast for error constructor | `a2a/client.ts:206` | S |
| L-09 | `skills/loader.ts:176` double cast skipping validation | `skills/loader.ts:176` | S |
| L-10 | `benchmarks/index.ts:47` null cast as TitanMemory | `benchmarks/index.ts:47` | S |
| L-11 | Redundant casts after Zod parse | `tools.ts:645,853` | S |
| L-12 | Missing `exactOptionalPropertyTypes` | `tsconfig.json` | S |

### Security (5)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| L-13 | `config.json` tracked in git, not gitignored | `.gitignore`, `config.json` | S |
| L-14 | CSP allows `unsafe-inline` for scripts | `dashboard/middleware/security.ts:52` | S |
| L-15 | `parseInt` without radix or bounds | `dashboard/api.ts:140` | S |
| L-16 | Error messages expose internal details | `http-server.ts:219` | S |
| L-17 | No TLS documentation/warning for non-localhost | `http-server.ts` | S |

### Dependencies (5)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| L-18 | `dotenv` in production deps but never imported | `package.json` | S |
| L-19 | `@modelcontextprotocol/sdk` version range too loose (`^1.0.0`) | `package.json` | S |
| L-20 | `@types/node@^20` vs actual Node v24 runtime | `package.json` | S |
| L-21 | No `files` field — npm pack includes tests/docs | `package.json` | S |
| L-22 | `maxWorkers: 1` forces serial test execution | `jest.config.js` | M |

### Testing (3)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| L-23 | Real `setTimeout(50)` in tests | `tests/context-monitor.test.ts:267,272` | S |
| L-24 | Weak assertions (`toBeDefined` only) | `tests/titan.test.ts` multiple | S |
| L-25 | Mock typing inconsistent | `tests/storage.test.ts:212-237` | S |

### Documentation (2)

| # | Issue | Location | Effort |
|---|-------|----------|--------|
| L-26 | JSDoc coverage ~30% on public API | `src/index.ts`, `src/mcp/tools.ts` | L |
| L-27 | Missing CHANGELOG.md | Root | M |

---

## Testing Gap Analysis

### Coverage Summary

| Metric | Actual | Required | Gap |
|--------|--------|----------|-----|
| Statements | 63.56% | 70% | -6.44pp |
| Branches | 46.71% | 70% | -23.29pp |
| Functions | 59.87% | 70% | -10.13pp |
| Lines | 64.81% | 70% | -5.19pp |

### Untested Subsystems (0% coverage)

| Subsystem | Files | Risk |
|-----------|-------|------|
| Compression | 6 files in `src/compression/` | Data integrity — corrupt compress/expand silently corrupts memories |
| LLM Turbo | `src/llm/turbo.ts` | 4 functions with null-return fallback paths, none tested |
| LLM Client | `src/llm/client.ts` (3.5%) | Retry logic, error handling untested |
| Benchmarks | 8 files in `src/benchmarks/` | Scoring calculations could fail silently |
| Context Capture | `src/utils/context-capture.ts` (5%) | User-facing suggestions feature |

### Critical Untested Paths

1. **LLM fallback chain**: `turbo.ts` returns `null` on failure, callers fall back to algorithmic. Neither path tested.
2. **A2A message handling**: 724 lines uncovered (`a2a/server.ts:197-920`) — lock acquisition, conflict resolution, subscription filtering.
3. **Decay strategies**: 13.41% covered — directly controls which memories survive `prune()`. Algorithm bugs silently destroy data.
4. **23 of 30 MCP tools**: Only `titan_stats`, `titan_add`, `titan_recall`, `titan_today`, `titan_prune`, `titan_get`, and error paths tested at runtime.

### Test Addition Priority

| Priority | Test File to Create | Target Coverage | Effort |
|----------|-------------------|-----------------|--------|
| 1 | `tests/decay-strategies.test.ts` | 80%+ | M |
| 2 | `tests/utility.test.ts` | 80%+ | M |
| 3 | `tests/llm-turbo.test.ts` | 70%+ | M |
| 4 | Expand `tests/titan.test.ts` | 70%+ | L |
| 5 | Expand `tests/mcp.test.ts` (all 30 tools) | 70%+ | L |
| 6 | `tests/compression.test.ts` | 70%+ | M |
| 7 | `tests/a2a-client.test.ts` | 50%+ | M |
| 8 | Expand `tests/a2a-extended.test.ts` | 50%+ | L |

---

## LLM Turbo Temporal Regression — Root Cause Analysis

### Known Issue

LLM Turbo's `processForRecall` in the Cortex pipeline disrupts time-ordering of recall results.

### Root Cause

`src/cortex/pipeline.ts` runs the Librarian pipeline which calls `llmRerank()` (`src/llm/turbo.ts:94-157`). The LLM reranker assigns relevance scores and reorders results purely by semantic relevance, discarding the original temporal ordering. When a `timeline_query` intent is detected (`titan.ts:769-793`), there's a guard that skips LLM reranking — but for non-timeline queries, the temporal signal is lost.

The conflict is at `titan.ts:785-793`: after LLM reranking blends scores, the results are sorted by `llmScore * 0.6 + originalScore * 0.4`, which overrides any temporal weighting that the adaptive memory layer applied earlier.

### Fix Approach

1. Preserve original timestamps before LLM reranking
2. After LLM rerank scoring, apply temporal sort as a post-processing tiebreaker (not a replacement)
3. For timeline queries, skip LLM reranking entirely (already implemented)
4. For non-timeline queries, use temporal proximity as a secondary sort key when LLM scores are within 0.05 of each other

**Effort:** M (2-3 hours)
**Files:** `src/titan.ts:785-793`, `src/cortex/pipeline.ts:267-303`

---

## Missing Documentation

| Document | Priority | Effort | Description |
|----------|----------|--------|-------------|
| Fix README benchmarks | HIGH | M | Update claimed scores to match actual data |
| CHANGELOG.md | HIGH | M | Backfill v2.0 to v2.1 changes |
| Config reference | HIGH | S | Document all `config.json` fields |
| Troubleshooting guide | MEDIUM | M | Common errors, Zilliz connectivity, sidecar debugging |
| Deployment guide | MEDIUM | M | Production config, scaling, security hardening |
| A2A protocol reference | MEDIUM | M | Message types, flows, error handling |
| Dashboard API reference | LOW | M | REST endpoints, WebSocket events |
| CONTRIBUTING.md | LOW | S | PR process, development setup |
| SECURITY.md | LOW | S | Security policy |

---

## Action Plan (Ordered by Impact-to-Effort Ratio)

### Phase 1: Quick Wins (1-2 days)

1. `npm audit fix` — resolves C-01, H-01, H-02 (3 CVEs)
2. Fix timing-unsafe token comparison (C-03) — `crypto.timingSafeEqual()`
3. Pass `topN: limit` to Voyage reranker (H-07) — 15-minute change, halves reranker cost
4. Add `config.json` to `.gitignore`, ship `config.example.json` (L-13)
5. Fix `as any` casts in `dashboard/api.ts` (H-05) — add Zod validation
6. Add LRU eviction to `LongTerm.memoryCache` (M-14)
7. Add request body size limit to dashboard (M-18)
8. Remove `dotenv` from production deps (L-18)
9. Clean stale `dist/catbrain/` + add `rimraf dist/` to build (M-07)

### Phase 2: Performance (2-3 days)

10. Batch sidecar calls (C-02) — biggest single performance win
11. Replace `getRecentMemories(50)` with in-memory buffer (H-11)
12. Parallelize `recordAccess()` calls (M-13)
13. Cache sentence splitting results (M-15)
14. Fix temporal regression in LLM reranking

### Phase 3: Security Hardening (1-2 days)

15. Default localhost bypass to `false` (H-04)
16. Add WebSocket auth to dashboard (H-12)
17. Add rate limiting (M-17)
18. Add sidecar auth (M-19)
19. Tighten MCP SDK version range (L-19)

### Phase 4: Testing (3-5 days)

20. Add decay strategy tests (highest risk gap)
21. Add utility tracking tests
22. Add LLM turbo + client tests
23. Expand titan.test.ts coverage
24. Test all 30 MCP tools
25. Add compression round-trip tests
26. Raise coverage threshold to 80%

### Phase 5: Architecture (1-2 weeks, incremental)

27. Install ESLint + configure (H-09)
28. Extract `MemoryAdminManager` from `titan.ts`
29. Extract `CortexManager` and `MirasManager`
30. Extract `Phase3CognitiveManager`
31. Extract `MemoryCRUDManager`
32. Refactor `handleToolCall` into handler registry
33. Fix deep nesting in `a2a/server.ts`

### Phase 6: Documentation (ongoing)

34. Fix README benchmark numbers
35. Create CHANGELOG.md
36. Write config reference
37. Write troubleshooting guide
38. Add JSDoc to public API

---

## Good Patterns Found

These patterns are worth preserving and extending:

- **Consistent initialization guard** (`if (!this.initialized) await this.initialize()`) on every public method
- **Fire-and-forget post-store** with `.catch()` — prevents Phase 3 processing from blocking writes
- **`rawMode` flag** cleanly gates all safety overhead for benchmark isolation
- **CircularAccessBuffer** — correct O(1) bounded-history data structure
- **Proper `Promise.all()`** in `initialize()`, `close()`, `getStats()`
- **LLM graceful degradation** — `llmRerank()` returns `null` on failure, callers fall back to algorithmic
- **Zod validation at MCP boundary** — all 30 tools validate input before passing to business logic
- **`body: unknown` on ApiRequest** — forces explicit narrowing per handler
- **Environment-only secrets** — no hardcoded API keys, all from `process.env`
- **Path traversal protection** in dashboard static file server
- **Embedding LRU cache** — 10,000 entries with TTL, correct eviction

---

## Validation Commands

```bash
cd C:/Users/Travi/.claude/titan-memory

# Verify checkpoint
git tag -l pre-audit-checkpoint

# Build
npm run build

# Tests
npm test

# Coverage
npm run test:coverage

# Type check
npx tsc --noEmit

# Security
npm audit

# Outdated deps
npm outdated
```

## Emergency Rollback

```bash
# Option 1: Git rollback
git -C "C:/Users/Travi/.claude/titan-memory" reset --hard pre-audit-checkpoint

# Option 2: Full directory restore
rm -rf "C:/Users/Travi/.claude/titan-memory"
cp -r "C:/Users/Travi/.claude/titan-memory-backup-pre-audit" "C:/Users/Travi/.claude/titan-memory"
```
