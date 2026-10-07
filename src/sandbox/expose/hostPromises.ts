import {
	type QuickJSAsyncContext,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	Scope,
} from 'quickjs-emscripten-core'

type Context = QuickJSContext | QuickJSAsyncContext
const pending = new WeakMap<Context, Set<() => void>>()

/** Cancel bridge ownership while the context is still alive, before its Scope is disposed. */
export function disposeHostPromises(ctx: Context): void {
	const entries = pending.get(ctx)
	pending.delete(ctx)
	if (entries) for (const cancel of [...entries]) cancel()
}

/** The argument-conversion Scope is short-lived; async values need context-lifetime ownership. */
export function hostPromiseHandle(
	ctx: Context,
	input: Promise<unknown>,
	convert: (scope: Scope, value: unknown) => QuickJSHandle,
): QuickJSHandle {
	const promise = ctx.newPromise()
	const state: {
		ctx?: Context
		promise?: QuickJSDeferredPromise
		convert?: typeof convert
	} = { ctx, promise, convert }
	let entries = pending.get(ctx)
	if (!entries) {
		entries = new Set()
		pending.set(ctx, entries)
	}
	const cancel = () => {
		const context = state.ctx
		const deferred = state.promise
		state.ctx = undefined
		state.promise = undefined
		state.convert = undefined
		if (context) pending.get(context)?.delete(cancel)
		// Resolve/reject handles must be freed before JS_FreeContext, even if input never settles.
		if (deferred?.alive) deferred.dispose()
	}
	entries.add(cancel)

	const settle = (reject: boolean, value: unknown) => {
		const context = state.ctx
		const deferred = state.promise
		const converter = state.convert
		if (!context?.alive || !deferred || !converter) return
		const scope = new Scope()
		let handle: QuickJSHandle | undefined
		try {
			handle = converter(scope, value)
			if (reject) deferred.reject(handle)
			else deferred.resolve(handle)
		} catch (error) {
			// Conversion failures belong to the guest promise, not an unobserved input.then chain.
			if (context.alive && deferred.alive) {
				const fallback = context.newError(
					error instanceof Error
						? { name: error.name, message: error.message }
						: { name: 'Error', message: String(error) },
				)
				try {
					deferred.reject(fallback)
				} finally {
					fallback.dispose()
				}
			}
		} finally {
			if (handle?.alive) handle.dispose()
			scope.dispose()
			cancel()
		}
		// Match the existing bridge's microtask kick, without accessing a retired context
		// or retaining a caller-owned pending-job error result.
		queueMicrotask(() => {
			if (context.alive) context.runtime.executePendingJobs().dispose()
		})
	}
	// The callbacks guard lifetime *before* conversion. A retired context drops results,
	// while the host operation itself is allowed to finish (no implied cancellation).
	void input.then(
		value => settle(false, value),
		error => settle(true, error),
	)
	return promise.handle
}
