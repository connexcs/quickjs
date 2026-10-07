# Changelog

All notable changes to this project will be documented in this file.

## [3.0.13] - Unreleased

### QuickJS compatibility

- Retain the 0.31.x core/FFI/WASM stack. The proposed 0.32.0 upgrade is deferred pending compatibility and failure-recovery validation; callback overflow remains a known limitation.
- Optional WASM peer dependencies require 0.31.x. Loaders validate a host-function round trip before `evalCode` executes guest code, so incompatible variants fail clearly instead of silently returning undefined.
- See [the upgrade assessment](website/docs/quickjs-upgrade-assessment.md) for reproduced failures, upstream fixes, test limitations, and the future upgrade checklist.

### Host promise bridge

- Returned promise handles remain caller-owned after resolve or reject; bridge cleanup releases its own independent handle and resolvers. Callers must dispose their handles before context teardown.
- Exceptions from the bridge's best-effort pending-job microtask no longer escape into the host process. Active evaluators continue polling jobs and report observed failures.
- When host-to-guest conversion fails, the fallback rejection forwards the error name and message, but does not copy its host stack. This limitation concerns conversion-failure fallbacks, not ordinary host promise rejections.

### Timer behavior changes

- Timer callback throws and returned promise rejections now fail an active evaluation with `ok: false`; previously they were ignored. Only the first failure is returned. Errors after evaluation teardown do not change an already returned result. Catch expected background errors inside the callback to keep evaluation running.
- Pending-job errors observed by the evaluator's event loop also fail the evaluation, with their owned results disposed.
- Missing or non-function callbacks throw a descriptive `TypeError`.
- `setImmediate` uses its own concurrent limit based on `maxTimeoutCount`, independently of pending timeouts.
- Clear functions accept IDs from any timer kind. Timeout, interval, and immediate callbacks receive their extra arguments.

### Example: background timer errors now fail evaluation

A timer error now stops an evaluation that is still waiting for its result:

```ts
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadQuickJs } from '@connexcs/quickjs'

const { runSandboxed } = await loadQuickJs(variant)
const result = await runSandboxed(({ evalCode }) => evalCode(`
  setTimeout(() => { throw new Error('bg') }, 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  export default 'done'
`))

// Before 3.0.13: result.ok === true; result.data === 'done'
// From 3.0.13:   result.ok === false; result.error.message === 'bg'
```

The same applies when an async timer callback returns a rejected promise. To allow an expected background failure without failing evaluation, catch it inside the callback, including errors from awaited operations:

```ts
const result = await runSandboxed(({ evalCode }) => evalCode(`
  setTimeout(async () => {
    try {
      await Promise.reject(new Error('bg'))
    } catch (error) {
      // Handle the expected failure here, e.g. record it or schedule a retry.
    }
  }, 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  export default 'done'
`))

// result.ok === true; result.data === 'done'
```

Only the first failure is returned. Timers are cancelled when evaluation ends; a rejection arriving after teardown cannot change a result already returned. These examples also apply to `setImmediate` and `setInterval`, and to the async QuickJS loader.

### Memory fixes

- Release owned fulfilled/rejected promise-state snapshot handles during serialization, and release resolved value/error handles even if conversion throws. This leak also affected 0.31.0. After this fix, both 0.32.0 Asyncify variants retained a 16 MiB WASM heap with constant sampled live engine memory across 2,000 shared-runtime evaluations each.

- Release timer callbacks and arguments on completion, cancellation, or teardown, including self-cancellation. Dispose successful and failed callback results.

## [unreleased]

### 📚 Documentation

- Add blog entry v3.0
- Fix minor doc issues

### ⚙️ Miscellaneous Tasks

- Remove dependency

## [2.3.1] - 2025-06-24

### ⚙️ Miscellaneous Tasks

- Lint
- Update packages
- Update linter deps
- Bump version
- Bump jsr version

## [2.3.0] - 2025-06-21

### 🚀 Features

- Improve node timers compatibility

### 📚 Documentation

- Update runtime and ts instructions

### ⚙️ Miscellaneous Tasks

- Bump jsr.json version
- Update packages
- Lint
- Fix lint
- Bump to version 2.3.0
- Update packages

## [2.2.0] - 2025-04-30

### 🐛 Bug Fixes

- Typing
- Typings
- WASM crash if env async function throws error #68

### 📚 Documentation

- Clarify executionTimeout is in milliseconds

### ⚙️ Miscellaneous Tasks

- Generate website in CI and add api docs
- Remove docs as they are now CI build
- Add docs build folder to git ignore
- Add build & test CI
- Bump dependencies
- Align test
- Cleanup code
- Improve typings
- Minor improvements
- Bump dependencies

## [2.1.1] - 2025-03-09

### 🐛 Bug Fixes

- SetTimeout 2nd parameter is optional #59
- Clear timeout in result promise on success #65

### 📚 Documentation

- Timeouts are in milliseconds not seconds fixes #61
- Correct documentation
- Update website

### ⚙️ Miscellaneous Tasks

- Bump jsr version
- Correct test file name
- Improve provideTimingFunctions
- Bump jsr version

## [2.1.0] - 2025-03-06

### 🐛 Bug Fixes

- Set executionTimeout for sandbox #57

### 📚 Documentation

- Add online playground
- Fix playground
- Update repo readme
- Cleanup and update docs
- Update website

### ⚙️ Miscellaneous Tasks

- Update np config
- Cleanup examples
- Improve error handling
- Improve tests

## [2.0.1] - 2025-02-28

### 🐛 Bug Fixes

- Fetch adapter response mapping

### 📚 Documentation

- Fix og image
- Fix og image
- Update doc and browser example

### ⚙️ Miscellaneous Tasks

- Bump jsr version

## [2.0.0] - 2025-02-27

### 🚀 Features

- Re-implement in new structure
- Handle function result and add example
- Add async module loader support
- Add node:events polyfill based on eventemitter3
- Make path normalizer configurable

### 🐛 Bug Fixes

- Timer functions and add example
- Fs promise

### 📚 Documentation

- Fix example
- Add documentation about platform support
- Add browser example and documentation
- Update doc
- Update browser example
- Update example
- Update example
- Fix example
- Fix example
- Fix typo
- Fix test doc
- Update docs and examples to new api
- Update readme
- Improve and add examples
- Extend basic example
- Add inline doc
- Setup vitepress for new website
- Update doc
- Add instruction to install quickjs wasm
- Add example for async usage with esm.sh module loading
- Update documentation
- New website #49
- Update documentation

### ⚙️ Miscellaneous Tasks

- Update example
- Update doc
- Bump packages
- Remove QuickJS-emscripten-sync dependency #34
- Implement new api
- Update examples
- Bump versions
- Mark old api as deprecated
- Cleanup
- Update tests
- Bump packages
- Remove config flag
- Enable test
- Remove tests from deprecated code
- Remove test for deprecated functions
- Use np for release and publish
- Fix lint
- Improve build step
- Cleanup examples
- Bump packages
- Correct function handling and add tests
- Add examples
- Minor improvements and fixes
- Update project settings
- Cleanup and remove v1.x code
- Bump deps
- Update npmignore
- Improve mapping
- Update tsconfig.json
- Update lint config
- Add package-lock.json
- Update jsr.json to pre-release version
- Fix browser example
- Set package version to v2 pre-release
- Re-organize and add tests
- Cleanup code
- Exclude docs from lint
- Update project config
- Fix build
- Bump jsr version

## [1.3.0] - 2024-07-11

### 🚀 Features

- Add compileOnly functionality #16
- Typescript support - Run Typescript in the QuickJS sandbox #20
- Improve customization #19
- Extend test runner result with summary and global passed flag #17
- Improve setTimeout and setInterval #7

### ⚙️ Miscellaneous Tasks

- Cleanup
- Improve node compatibility #14
- Cleanup
- Make Buffer and TextDecoder and TextEncoder global
- Bump to v1.3

## [1.2.0] - 2024-07-09

### 🚀 Features

- Improve custom virtual file system and module loader to allow relative imports #8

### 💼 Other

- Testrunner does not return the Errors in the response #11

### ⚙️ Miscellaneous Tasks

- Bump to version 1.2

## [1.1.1] - 2024-07-08

### 🐛 Bug Fixes

- Add missing type declaration

### ⚙️ Miscellaneous Tasks

- Bump version to 1.1.0

## [1.1.0] - 2024-07-08

### 🚀 Features

- Abstract the fetch client #1

### 🐛 Bug Fixes

- Custom node module handling and types

### 📚 Documentation

- Extend documentation
- Update
- Add documentation
- Add custom module example

### ⚙️ Miscellaneous Tasks

- Remove debug logs

## [1.0.0] - 2024-07-07

### 🚀 Features

- Add implementation
- Improve compatibility
- Implement timeout handling

### 🐛 Bug Fixes

- Testrunner timeouts

### 📚 Documentation

- Update doc
- Create structure
- Update doc
- Update doc
- Update doc
- Update

### ⚙️ Miscellaneous Tasks

- Initial commit
- Cleanup and add docu
- Cleanup
- Update gitignore
- Improve code
- Add test runner and prepare doc
- Add vendor to tshy exclude
- Update doc
- Update
- Update credits

<!-- generated by git-cliff -->
