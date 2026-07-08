import { newQuickJSWASMModuleFromVariant, Scope, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core'
import { getTypescriptSupport } from './getTypescriptSupport.js'
import { setupFileSystem } from './sandbox/setupFileSystem.js'
import { executeSandboxFunction } from './sandbox/syncVersion/executeSandboxFunction.js'
import { getModuleLoader } from './sandbox/syncVersion/getModuleLoader.js'
import { modulePathNormalizer } from './sandbox/syncVersion/modulePathNormalizer.js'
import { prepareNodeCompatibility } from './sandbox/syncVersion/prepareNodeCompatibility.js'
import { prepareSandbox } from './sandbox/syncVersion/prepareSandbox.js'
import type { LoadQuickJsOptions } from './types/LoadQuickJsOptions.js'
import type { SandboxFunction } from './types/SandboxFunction.js'
import type { SandboxOptions } from './types/SandboxOptions.js'

/**
 * Loads the QuickJS module and returns a sandbox execution function.
 * @param variant - Options for loading the QuickJS module. Defaults to '@jitl/quickjs-ng-wasmfile-release-sync'.
 * @returns An object containing the runSandboxed function and the loaded module.
 */
export const loadQuickJs = async (variant: LoadQuickJsOptions) => {
	const module = await newQuickJSWASMModuleFromVariant(variant)

	// One long-lived runtime shared across calls; each call gets a fresh, isolated context that is
	// disposed at the end of the call. This mirrors `loadAsyncQuickJs.ts` - see the detailed comment
	// there. The sync WASM build does not leak on runtime teardown the way the asyncify build does
	// (https://github.com/justjake/quickjs-emscripten/issues/261), but reusing the runtime here keeps
	// both loaders structurally identical and avoids the per-call `QTS_NewRuntime`/`QTS_FreeRuntime`
	// churn entirely.
	const runtime = module.newRuntime()

	// Serializes calls so per-call runtime settings (memory limit, timeout, module loader) never
	// interleave. Sync eval is already serial within a WASM call; this also covers the `await`s below.
	let queue: Promise<unknown> = Promise.resolve()

	/**
	 * Provides a new sandbox and executes the given function.
	 * When the function has been finished, the sandbox gets disposed and can longer be used.
	 *
	 * @param sandboxedFunction
	 * @param sandboxOptions
	 * @returns
	 */
	const runSandboxed = <T>(sandboxedFunction: SandboxFunction<T>, sandboxOptions: SandboxOptions = {}): Promise<T> => {
		const run = async (): Promise<T> => {
			const scope = new Scope()
			const ctx = scope.manage(runtime.newContext())

			try {
				// Runtime-level settings, applied per call and reset in `finally` (the runtime is shared).
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
				const { transpileVirtualFs, transpileFile } = await getTypescriptSupport(
					sandboxOptions.transformTypescript,
					sandboxOptions.typescriptImportFile,
					sandboxOptions.transformCompilerOptions,
				)
				// if typescript support is enabled, transpile all ts files in file system
				transpileVirtualFs(fs)

				// JS Module Loader
				const moduleLoader = sandboxOptions.getModuleLoader
					? sandboxOptions.getModuleLoader(fs, sandboxOptions)
					: getModuleLoader(fs, sandboxOptions)
				runtime.setModuleLoader(moduleLoader, sandboxOptions.modulePathNormalizer ?? modulePathNormalizer)

				// Register Globals to be more Node.js compatible
				prepareNodeCompatibility(ctx, sandboxOptions)

				// Prepare the Sandbox
				// Expose Data and Functions to Client
				prepareSandbox(ctx, scope, sandboxOptions, fs)

				// Run the given Function
				return await executeSandboxFunction({
					ctx,
					fs,
					scope,
					sandboxOptions,
					sandboxedFunction,
					transpileFile,
				})
			} catch (error) {
				throw error instanceof Error ? error : new Error('Internal Error')
			} finally {
				// Reset every per-runtime setting this call may have changed so the shared runtime is clean
				// for the next call, then dispose only the context (the runtime lives on).
				if (sandboxOptions.executionTimeout) {
					runtime.removeInterruptHandler()
				}
				if (sandboxOptions.memoryLimit) {
					runtime.setMemoryLimit(-1) // -1 = unlimited (the default)
				}
				if (sandboxOptions.maxStackSize) {
					runtime.setMaxStackSize(0) // 0 = unset (the default)
				}
				// Detach the module loader (per-runtime, closes over this call's `fs`).
				runtime.removeModuleLoader()
				scope.dispose()
			}
		}

		// Chain onto the queue so only one sandbox runs at a time on the shared runtime.
		const result = queue.then(run, run)
		queue = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	return { runSandboxed, module }
}
