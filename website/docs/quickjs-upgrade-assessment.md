# QuickJS 0.32.0 upgrade assessment

Assessed on 7 October 2026. This release retains the **0.31.x** core, FFI, and WASM stack. The package version remains **3.0.13** as requested. The serializer, promise-ownership, and timer fixes remain included; the dependency upgrade is deferred.

## Why the upgrade is deferred

| Concern | Evidence and status |
| --- | --- |
| Incompatible core/WASM versions | Arithmetic can succeed while host callbacks silently return `undefined`. This affects console, env functions, fetch, and filesystem bindings. Optional variant peers now require 0.31.x, and loaders reject the 0.32 HostRef ABI at load time and verify a host callback before evaluating guest code. The round-trip probe uses the evaluation context, rather than creating/tearing down an extra runtime; pure `validateCode` checks do not invoke host callbacks. |
| Explicit Asyncify runtime teardown | Reproduced: the same minimal teardown completes on 0.31.0 but fails on 0.32.0 with `QuickJSRuntime ... not found ... free HostRef`. [Issue #261](https://github.com/justjake/quickjs-emscripten/issues/261) remains open. [PR #256](https://github.com/justjake/quickjs-emscripten/pull/256) was merged on 23 July 2026, but the published 0.32.0 package does not contain the fix. The loaders reuse a runtime and dispose individual contexts, avoiding that path. |
| Sequential asyncified calls | [Issue #258](https://github.com/justjake/quickjs-emscripten/issues/258) is open. An additional local low-level probe failed with a memory-access error; its job-pumping/Asyncify interaction still needs isolation. This is not proof that every sequential sandbox call fails. |
| OOM recovery | [Issue #257](https://github.com/justjake/quickjs-emscripten/issues/257) reports a 0.32.0 teardown regression after OOM with persistent objects. Our extra memory-limit probe failed during timer-provider setup, before normal evaluation error handling. It does not establish the same root cause; setup and recovery need dedicated validation. |
| Other teardown assertions | [Issue #235](https://github.com/justjake/quickjs-emscripten/issues/235) also reports large-object/promise teardown failures on 0.31.0. Similar symptoms do not establish identical causes. |

The Git history does **not** contain an identifiable downgrade commit on this fork's main line. Commit `95643ed` (8 July 2026) documents the earlier memory growth, `table index is out of bounds`, and teardown failures that motivated sharing a runtime. It describes symptoms affecting both versions; this is historical evidence, not proof of the exact reason for a previous downgrade elsewhere.

## What passed, and what that establishes

The coherent 0.32.0 candidate passed 70,000 cumulative registrations per context in legacy Asyncify, NG Asyncify, and NG sync. Old live callbacks and guest-held callbacks retained their identity, and serialization, host promises, async callbacks, and context-owned teardown worked. [Upstream PR #227](https://github.com/justjake/quickjs-emscripten/pull/227) replaces the old callback mechanism with HostRefs.

The full suite passed when test files ran in separate processes. Combined runs had intermittent initialization timeouts; those are not established upgrade regressions, but should be monitored in CI. The earlier `validateCode` failure likewise appears intermittent, not a proven leftover-state defect.

A separate serializer leak was found in both 0.31.0 and 0.32.0: settled promise-state snapshots own their value/error handles. Releasing those snapshots restored flat sampled memory. After the fix, 0.31.0 legacy Asyncify and both 0.32.0 Asyncify variants each completed 2,000 shared-runtime evaluations with a 16 MiB WASM heap and constant sampled live engine memory. This is bounded soak-test evidence, not a guarantee for every workload or teardown pattern.

## Restored 0.31.x release validation

The final combined run reported **455 passed, 3 skipped, 1 failed**. The skipped tests are the intentionally opt-in overflow checks. The remaining failure is the intermittent async `validateCode` valid-input check; an isolated rerun passed both validation tests. An earlier combined run passed all 456 enabled tests. This remains a CI concern and is not classified as fixed.

Real 0.32.0 NG sync, NG Asyncify, and legacy Asyncify variants were each rejected with the explicit 0.31.x compatibility error. Matching variants and deliberately broken callback bindings were also tested. Both restored 0.31.0 Asyncify variants completed 2,000 evaluations each with a 16 MiB WASM heap and stable sampled live engine memory after warmup. TypeScript, changed-file lint, and the production build passed.

## Known limitation retained in 0.31.x

Callback IDs still overflow after roughly 65,536 registrations in one context. With older callbacks still live, overflow can invoke the **wrong callback**, not merely return `undefined`. The exact failing registration depends on earlier registrations. Disposing earlier functions does not reset the counter. Reusing a runtime with fresh contexts bounds the counter per evaluation, but a sufficiently busy individual evaluation can still reach it.

Do not wrap IDs manually over live callbacks. Issue #4 remains deferred; the overflow is not fixed by the serializer or timer changes.

The future-upgrade test is preserved as an opt-in check:

```sh
QUICKJS_UPGRADE_TESTS=1 bun test src/test-regression/callback-overflow.test.ts
```

It is expected to fail on 0.31.0 and is skipped in the normal suite. Against a candidate upgrade it must pass for all three variants, with old and new callbacks invoking the correct handlers.

## Requirements before a future upgrade

1. Use coherent core/FFI/WASM versions, with optional peer ranges and loader validation updated together. Document the ABI change and plan a separate minor or major release rather than silently changing 3.0.13.
2. Prefer a published release containing PR #256; otherwise explicitly validate and support teardown with a maintained fix. Use a range confined to that compatible 0.x series so patch fixes can be adopted.
3. Isolate sequential asyncified-call and OOM recovery probes. Dispose all caller-owned results, validate job pumping, and confirm a subsequent execution succeeds after each handled failure.
4. Run callback-overflow, promise ownership, serialization, timer, filesystem, and combined-suite tests. Monitor initialization timeouts rather than assuming isolation proves combined execution healthy.
5. Repeat memory soaks and representative production workloads, including multiple awaits, large objects, memory limits, timeouts, late host settlement, context isolation, and actual shutdown behavior.

No npm publication is part of this assessment.
