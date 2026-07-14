import {
	type JSPromiseState,
	type QuickJSAsyncContext,
	type QuickJSContext,
	type QuickJSHandle,
	Scope,
} from 'quickjs-emscripten-core'
import type { SerializeState } from '../../types/SerializeState.js'
import { getHandle } from '../expose/expose.js'
import { call, SERIALIZE_ERROR, stashSerializeError } from '../helper.js'
import { getSerializer } from './serializer/index.js'

/**
 * Maximum object nesting depth we will serialize before giving up. Acts as a backstop
 * against pathologically deep graphs and any cycle the visited-`Set` fails to catch.
 */
const MAX_DEPTH = 200

/**
 * Serializer-handled constructors that can themselves contain arbitrary (and possibly
 * cyclic) values, so they participate in visited-tracking. Leaf value-types handled by a
 * serializer (Date, Buffer, ArrayBuffer, URL, …) are intentionally excluded — they can't
 * form a cycle, and excluding them means a shared instance still serializes each time.
 */
const CONTAINER_CONSTRUCTORS = new Set(['Map', 'Set'])

/**
 * Serialize data from guest to host.
 *
 * Cyclic / self-referential guest graphs are handled gracefully: a repeated reference
 * is replaced with a `'[Circular]'` marker rather than recursing forever. Genuine
 * failures (depth overflow, guest-call errors) throw with a descriptive message so they
 * bubble up to the caller instead of failing silently.
 *
 * @param ctx The sandbox context
 * @param handle The QuickJS handle to serialize
 * @param rootScope Scope owning long-lived handles created during serialization
 * @param state Internal recursion state (visited set + depth); created automatically on
 *   the top-level call — callers should not pass this.
 * @returns
 */
export const handleToNative = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	handle: QuickJSHandle,
	rootScope?: Scope,
	state?: SerializeState,
) => {
	const ty = ctx.typeof(handle)

	if (ty === 'undefined') {
		return undefined
	}
	if (ty === 'null') {
		return null
	}
	if (ty === 'number' || ty === 'string' || ty === 'boolean' || ty === 'bigint') {
		return ctx.dump(handle)
	}

	if (ty === 'symbol') {
		const desc = ctx.getString(ctx.getProp(handle, 'description'))
		return Symbol(desc)
	}

	const asPromiseState: JSPromiseState & { notAPromise?: boolean } = ctx.getPromiseState(handle)

	if (asPromiseState.type && !asPromiseState.notAPromise) {
		return ctx.resolvePromise(handle).then(val => {
			if (val.error) {
				const error = handleToNative(ctx, val.error, rootScope, state)
				val.error.dispose()
				return Promise.reject(error)
			}
			const value = handleToNative(ctx, val.value, rootScope, state)
			val.value.dispose()
			return Promise.resolve(value)
		})
	}

	// Everything below serializes an object / function — the only shapes that can be
	// cyclic. Lazily create the recursion state (a guest-side visited `Set` + depth) on
	// the first such call and thread it into every recursive descent. `===` object
	// identity is reliable inside the guest, so we ask the guest whether it has already
	// seen this exact object; a repeat resolves to `'[Circular]'` instead of recursing
	// forever. `quickjs-emscripten-core` exposes no host-side handle-equality primitive,
	// which is why the check lives guest-side. The Set is owned by `rootScope` so it is
	// disposed with the rest of the serialization's long-lived handles.
	const s: SerializeState =
		state ??
		{
			seen: rootScope
				? rootScope.manage(call(ctx, 'internal/serializer/newSeen.js', '() => new Set()', undefined))
				: undefined,
			depth: 0,
		}

	const childState: SerializeState = { seen: s.seen, depth: s.depth + 1 }

	if (s.depth > MAX_DEPTH) {
		const e = new RangeError(
			`Failed to serialize ${ty}: maximum object depth (${MAX_DEPTH}) exceeded — the guest value graph is too deeply nested or contains an undetected cycle`,
		)
		;(e as any)[SERIALIZE_ERROR] = true
		// Stash so the message survives if this throw happens inside a guest callback.
		stashSerializeError(ctx, e)
		throw e
	}

	// `seen` tracks the objects on the *current ancestor path* (not every object ever
	// visited), so only genuine cycles — an object that reappears while it is still being
	// serialized — are flagged; a shared but acyclic subtree that appears in two sibling
	// branches serializes fully in each. `markSeen` adds the object and returns true if it
	// was already on the path (a cycle); `unmarkSeen` removes it once its subtree is done.
	// Identity is checked guest-side because `quickjs-emscripten-core` exposes no host-side
	// handle-equality primitive. Without a `seen` Set (no root scope) we fall back to the
	// depth guard above.
	const markSeen = (h: QuickJSHandle): boolean =>
		s.seen
			? (call(
					ctx,
					'internal/serializer/markSeen.js',
					'(o, seen) => { if (seen.has(o)) return true; seen.add(o); return false }',
					undefined,
					h,
					s.seen,
				).consume(r => ctx.dump(r)) as boolean)
			: false

	const unmarkSeen = (h: QuickJSHandle): void => {
		if (!s.seen) return
		call(
			ctx,
			'internal/serializer/unmarkSeen.js',
			'(o, seen) => { seen.delete(o) }',
			undefined,
			h,
			s.seen,
		).dispose()
	}

	// biome-ignore lint/complexity/noBannedTypes: ok here
	const setProperties = (obj: Object | Function, h: QuickJSHandle) => {
		ctx
			.newFunction('', (key, value) => {
				const keyName = handleToNative(ctx, key, rootScope, childState)
				if (typeof keyName !== 'string' && typeof keyName !== 'number' && typeof keyName !== 'symbol') return

				const desc = (
					[
						['value', true],
						['get', true],
						['set', true],
						['configurable', false],
						['enumerable', false],
						['writable', false],
					] as const
				).reduce<PropertyDescriptor>((desc, [key, unmarshable]) => {
					const h = ctx.getProp(value, key)
					const t = ctx.typeof(h)

					if (t === 'undefined') return desc
					if (!unmarshable && t === 'boolean') {
						desc[key] = ctx.dump(h)
						return desc
					}

					try {
						desc[key] = handleToNative(ctx, h, rootScope, childState)
					} catch (error) {
						// Re-throw (never swallow). Errors already carrying a deliberate,
						// descriptive message (e.g. the depth-limit RangeError) pass through
						// untouched; anything else is wrapped with context about which property
						// failed, so the error that bubbles up identifies the culprit instead of
						// being an opaque low-level failure.
						if (error && (error as any)[SERIALIZE_ERROR]) {
							// Re-stash on the way up: this rethrow crosses the guest boundary of the
							// enclosing `call`, which would otherwise discard the descriptive error.
							stashSerializeError(ctx, error)
							throw error
						}
						const cause = (error as Error)?.message ?? String(error)
						const e = new Error(`Failed to serialize property "${String(keyName)}" (${t}): ${cause}`)
						;(e as any)[SERIALIZE_ERROR] = true
						e.cause = error
						// Stash so the message survives the guest boundary this callback runs behind.
						stashSerializeError(ctx, e)
						throw e
					} finally {
						h.dispose()
					}

					return desc
				}, {})

				Object.defineProperty(obj, keyName, desc)
			})
			.consume(f => {
				try {
					call(
						ctx,
						'internal/serializer/setProperties.js',
						`(o, fn) => {
							const descs = Object.getOwnPropertyDescriptors(o);
							Object.entries(descs).forEach(([k, v]) => fn(k, v));
							Object.getOwnPropertySymbols(descs).forEach(k => fn(k, descs[k]));
						}`,
						undefined,
						h,
						f,
					).dispose()
				} finally {
					// This object's subtree is done — remove it from the current path so a later,
					// non-cyclic sibling reference to the same object still serializes fully.
					unmarkSeen(h)
				}
			})
	}

	if (ty === 'function') {
		if (!rootScope) throw new Error('Missing root scope')
		if (markSeen(handle)) return '[Circular]'
		const cpHandle = rootScope.manage(handle.dup())

		const f = function (this: any, ...args: any[]) {
			const scope = new Scope()
			const thisHandle = getHandle(scope, ctx, '', this)
			const argHandles = args.map(a => getHandle(scope, ctx, '', a))

			if (new.target) {
				const instance = handleToNative(
					ctx,
					call(
						ctx,
						'internal/serializer/newClass.js',
						'(Cls, ...args) => new Cls(...args)',
						thisHandle,
						cpHandle,
						...argHandles,
					),
					rootScope,
				)
				Object.defineProperties(this, Object.getOwnPropertyDescriptors(instance))
				scope.dispose()
				return this
			}

			try {
				const resultHandle = scope.manage(ctx.unwrapResult(ctx.callFunction(cpHandle, thisHandle, ...argHandles)))
				const res = handleToNative(ctx, resultHandle, rootScope)
				return res
			} finally {
				scope.dispose()
			}
		}

		setProperties(f, handle)
		return f
	}

	if (ty === 'object') {
		const isNull = call(ctx, 'internal/serializer/isNull.js', 'a => a === null', undefined, handle).consume(r =>
			ctx.dump(r),
		)
		if (isNull) return null

		// Check for Error instances
		const errorType = call(
			ctx,
			'internal/serializer/detectErrorType.js',
			`(o) => {
				try {
					const tag = Object.prototype.toString.call(o)
					if (tag.startsWith('[object ') && tag.endsWith(']')) {
						const type = tag.slice(8, -1)
						if (type.endsWith('Error')) return type
					}
				} catch {}
				if (typeof o?.name === 'string' && typeof o?.message === 'string') return 'Error'
				return undefined
			}`,
			undefined,
			handle,
		).consume(r => ctx.dump(r))

		if (typeof errorType === 'string') {
			const errorSerializer = getSerializer(errorType)
			if (errorSerializer) {
				const ret = errorSerializer(ctx, handle, rootScope, childState)
				if (ret) {
					return ret
				}
			}

			const messageHandle = ctx.getProp(handle, 'message')
			const stackHandle = ctx.getProp(handle, 'stack')

			const message = ctx.dump(messageHandle) ?? ''
			const stack = ctx.dump(stackHandle)

			messageHandle.dispose()
			stackHandle.dispose()

			const e = new Error(message)
			e.name = errorType
			if (typeof stack === 'string') e.stack = stack

			return e
		}

		const isArray = call(ctx, 'internal/serializer/isArray.js', 'Array.isArray', undefined, handle).consume(r =>
			ctx.dump(r),
		)

		const obj: any = isArray ? [] : {}

		const constructorName = call(
			ctx,
			'internal/serializer/getConstructorName.js',
			`o => typeof o?.constructor?.name === 'string' ? o.constructor.name : undefined`,
			undefined,
			handle,
		).consume(r => ctx.dump(r))

		const serializer = getSerializer(constructorName)
		if (serializer) {
			// Container serializers (Map/Set) recurse into arbitrary element values and can
			// therefore be part of a cycle (e.g. `m.set('k', m)`), so mark them for the
			// duration of the walk before dispatching. Leaf value-types (Date, Buffer, URL, …)
			// can't contain a cycle, so they are left unmarked — a shared, non-cyclic instance
			// still serializes fully each time it appears rather than collapsing to
			// `'[Circular]'`.
			const isContainer = CONTAINER_CONSTRUCTORS.has(constructorName)
			if (isContainer && markSeen(handle)) return '[Circular]'
			try {
				const ret = serializer(ctx, handle, rootScope, childState)
				if (ret) {
					return ret
				}
			} finally {
				if (isContainer) unmarkSeen(handle)
			}
		}

		// Generic object / array: break cycles before recursing into its properties.
		if (markSeen(handle)) return '[Circular]'

		setProperties(obj, handle)

		return obj
	}

	throw new TypeError(`Failed to serialize ${ty}`)
}
