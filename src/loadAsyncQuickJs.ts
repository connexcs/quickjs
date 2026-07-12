import { newQuickJSAsyncWASMModuleFromVariant, Scope, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core'
import { getTypescriptSupport } from './getTypescriptSupport.js'
import { executeAsyncSandboxFunction } from './sandbox/asyncVersion/executeAsyncSandboxFunction.js'
import { getAsyncModuleLoader } from './sandbox/asyncVersion/getAsyncModuleLoader.js'
import { modulePathNormalizerAsync } from './sandbox/asyncVersion/modulePathNormalizerAsync.js'
import { prepareAsyncNodeCompatibility } from './sandbox/asyncVersion/prepareAsyncNodeCompatibility.js'
import { prepareAsyncSandbox } from './sandbox/asyncVersion/prepareAsyncSandbox.js'
import { setupFileSystem } from './sandbox/setupFileSystem.js'
import type { LoadAsyncQuickJsOptions } from './types/LoadQuickJsOptions.js'

import type { AsyncSandboxFunction } from './types/SandboxFunction.js'
import type { SandboxAsyncOptions } from './types/SandboxOptions.js'

/**
 * Loads the QuickJS async module and returns a sandbox execution function.
 * @param variant - Options for loading the QuickJS module. Defaults to '@jitl/quickjs-ng-wasmfile-release-asyncify'.
 * @returns An object containing the runSandboxed function and the loaded module.
 */
export const loadAsyncQuickJs = async (variant: LoadAsyncQuickJsOptions) => {
	const module = await newQuickJSAsyncWASMModuleFromVariant(variant)

	// One long-lived runtime is shared across every `runSandboxed` call; each call gets a fresh,
	// fully-isolated context (its own `globalThis`/realm) that is disposed at the end of the call.
	//
	// Why not `module.newContext()` (which creates a fresh runtime per call, as before)?
	// On the asyncify WASM build, tearing a runtime down (`JS_FreeRuntime`) leaks the whole per-call
	// WASM heap - ~35-52 KB per call, unbounded - until `QTS_NewRuntime` eventually can't allocate and
	// traps with "table index is out of bounds". See upstream
	// https://github.com/justjake/quickjs-emscripten/issues/261 and
	// https://github.com/justjake/quickjs-emscripten/pull/256. It leaks identically on 0.31 and 0.32,
	// and disposing the runtime explicitly instead *crashes* (`Assertion failed: list_empty(&rt->gc_obj_list)`)
	// whenever an async host function is used. Reusing the runtime and only disposing contexts sidesteps
	// both: `JS_FreeRuntime` is never called on the hot path, and context disposal (`JS_FreeContext`) is
	// leak-free. WASM heap stays flat across unbounded calls, verified including async host functions.
	//
	// Isolation: a fresh context gives each call its own global object and intrinsics; guest globals do
	// not bleed between calls. Runtime-level settings (memory limit, interrupt/timeout, module loader)
	// are shared, so they are (re)applied at the start of every call. To keep those per-call settings
	// from interleaving, calls are serialized through `queue` below. This costs no real parallelism: the
	// asyncify build already cannot run two `evalCodeAsync` calls concurrently on one WASM module (it has
	// a single suspend/resume state), so calls through one module were always serial. True parallelism
	// comes from separate workers, each with its own module + runtime.
	const runtime = module.newRuntime()

	// Serializes calls so per-call runtime settings never interleave. Each call awaits the previous one.
	let queue: Promise<unknown> = Promise.resolve()

	/**
	 * Provides a new sandbox and executes the given function.
	 * When the function has been finished, the sandbox gets disposed and can longer be used.
	 *
	 * @param sandboxedFunction
	 * @param sandboxOptions
	 * @returns
	 */
	const runSandboxed = <T>(
		sandboxedFunction: AsyncSandboxFunction<T>,
		sandboxOptions: SandboxAsyncOptions = {},
	): Promise<T> => {
		const run = async (): Promise<T> => {
			const scope = new Scope()
			const ctx = scope.manage(runtime.newContext())

			try {
				// These are runtime-level settings. Because the runtime is shared across calls, they are
				// applied per call here and reset in the `finally` so one call's limits never leak into the
				// next (e.g. an expired execution-timeout deadline must not interrupt a later call).
				if (sandboxOptions.executionTimeout) {
					runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + sandboxOptions.executionTimeout))
				}

				if (sandboxOptions.maxStackSize) {
					runtime.setMaxStackSize(sandboxOptions.maxStackSize)
				}

				if (sandboxOptions.memoryLimit) {
					runtime.setMemoryLimit(sandboxOptions.memoryLimit)
				}

				// Virtual File System,
				const fs = setupFileSystem(sandboxOptions)

				// TypeScript Support:
				const { transpileVirtualFs, transpileFile, remapStack } = await getTypescriptSupport(
					sandboxOptions.transformTypescript,
					sandboxOptions.typescriptImportFile,
					sandboxOptions.transformCompilerOptions,
				)
				// if typescript support is enabled, transpile all ts files in file system
				transpileVirtualFs(fs)

				// JS Module Loader
				const moduleLoader = sandboxOptions.getModuleLoader
					? sandboxOptions.getModuleLoader(fs, sandboxOptions)
					: getAsyncModuleLoader(fs, sandboxOptions)

				runtime.setModuleLoader(moduleLoader, sandboxOptions.modulePathNormalizer ?? modulePathNormalizerAsync)

				// Register Globals to be more Node.js compatible
				await prepareAsyncNodeCompatibility(ctx, sandboxOptions)

				// Prepare the Sandbox
				// Expose Data and Functions to Client
				prepareAsyncSandbox(ctx, scope, sandboxOptions, fs)

				// Run the given Function
				return await executeAsyncSandboxFunction({
					ctx,
					fs,
					scope,
					sandboxOptions,
					sandboxedFunction,
					transpileFile,
					remapStack,
				})
			} finally {
				// Reset every per-runtime setting this call may have changed, so the shared runtime is
				// clean for the next call, then dispose only the context (the runtime lives on).
				if (sandboxOptions.executionTimeout) {
					runtime.removeInterruptHandler()
				}
				if (sandboxOptions.memoryLimit) {
					runtime.setMemoryLimit(-1) // -1 = unlimited (the default)
				}
				if (sandboxOptions.maxStackSize) {
					runtime.setMaxStackSize(0) // 0 = unset (the default)
				}
				// Detach the module loader (its native trampoline is per-runtime and this loader closes
				// over this call's `fs`).
				runtime.removeModuleLoader()
				scope.dispose()
			}
		}

		// Chain onto the queue so only one sandbox runs at a time on the shared runtime. The result of
		// this call is isolated from the queue's success/failure tracking so one call cannot reject another.
		const result = queue.then(run, run)
		queue = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	return { runSandboxed, module }
}
