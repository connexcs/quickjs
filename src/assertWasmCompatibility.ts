import {
	type QuickJSAsyncContext,
	type QuickJSAsyncWASMModule,
	type QuickJSContext,
	type QuickJSWASMModule,
	Scope,
} from 'quickjs-emscripten-core'

const message =
	'Incompatible QuickJS WASM variant: this package requires a 0.31.x variant matching quickjs-emscripten-core. Install your @jitl/quickjs-*-wasmfile-* variant at ~0.31.0.'

export const assertWasmCompatibility = (module: QuickJSWASMModule | QuickJSAsyncWASMModule) => {
	// 0.32's HostRef ABI changes QTS_NewFunction. Reject it before calling into
	// that incompatible signature; a plain arithmetic eval would still succeed.
	if ('QTS_NewHostRef' in module.getFFI()) throw new Error(message)
}

// Use the live evaluation context: do not add runtime teardown to loader startup.
export const assertHostCallbackCompatibility = (ctx: QuickJSContext | QuickJSAsyncContext) => {
	const scope = new Scope()
	try {
		const fn = scope.manage(ctx.newFunction('compatibilityProbe', () => ctx.newNumber(731)))
		const result = ctx.callFunction(fn, ctx.undefined)
		try {
			if (result.error || ctx.dump(result.value) !== 731) throw new Error(message)
		} finally {
			result.dispose()
		}
	} catch (cause) {
		throw new Error(message, { cause })
	} finally {
		scope.dispose()
	}
}
