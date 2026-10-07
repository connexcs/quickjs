import { beforeAll, describe, expect, it } from 'bun:test'
import ng from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import sync from '@jitl/quickjs-ng-wasmfile-release-sync'
import legacy from '@jitl/quickjs-wasmfile-release-asyncify'
import {
	newQuickJSAsyncWASMModuleFromVariant,
	newQuickJSWASMModuleFromVariant,
	type QuickJSAsyncContext,
	Scope,
} from 'quickjs-emscripten-core'
import { getHandle } from '../sandbox/expose/expose.js'
import { disposeHostPromises } from '../sandbox/expose/hostPromises.js'
import { handleToNative } from '../sandbox/handleToNative/handleToNative.js'

const variants = [
	{ name: 'legacy asyncify', create: () => newQuickJSAsyncWASMModuleFromVariant(legacy) },
	{ name: 'ng asyncify', create: () => newQuickJSAsyncWASMModuleFromVariant(ng) },
	{ name: 'ng sync', create: () => newQuickJSWASMModuleFromVariant(sync) },
]
const modules = new Map<string, Awaited<ReturnType<(typeof variants)[number]['create']>>>()
// Opt in when assessing a candidate upgrade; 0.31.0 is known to fail this boundary.
const enabled = process.env['QUICKJS_UPGRADE_TESTS'] === '1'
beforeAll(async () => {
	if (!enabled) return
	await Promise.all(variants.map(async variant => modules.set(variant.name, await variant.create())))
})

for (const variant of variants) {
	describe(`callback registration - ${variant.name}`, () => {
		;(enabled ? it : it.skip)(
			'invokes callbacks beyond 65,536 cumulative registrations',
			async () => {
				const module = modules.get(variant.name)
				if (!module) throw new Error('Module not initialized')
				// Context-owned teardown avoids upstream Asyncify runtime finalizer-order issue #261.
				const ctx = module.newContext()
				const early = ctx.newFunction('early', () => ctx.newNumber(111))
				const guestOwned = ctx.newFunction('guestOwned', () => ctx.newNumber(222))
				ctx.setProp(ctx.global, 'guestOwned', guestOwned)
				guestOwned.dispose()
				const scope = new Scope()
				try {
					for (let i = 1; i <= 70000; i++) {
						const fn = ctx.newFunction('probe', () => ctx.newNumber(i))
						try {
							if (i >= 65535) {
								const result = ctx.callFunction(fn, ctx.undefined)
								try {
									expect(ctx.dump(ctx.unwrapResult(result))).toBe(i)
								} finally {
									result.dispose()
								}
							}
						} finally {
							fn.dispose()
						}
						if ([65535, 65536, 65537, 70000].includes(i)) {
							const result = ctx.callFunction(early, ctx.undefined)
							try {
								expect(ctx.dump(ctx.unwrapResult(result))).toBe(111)
							} finally {
								result.dispose()
							}
							expect(
								ctx
									.evalCode('guestOwned()')
									.unwrap()
									.consume(h => ctx.dump(h)),
							).toBe(222)
						}
					}
					const value = ctx.evalCode('({nested:{value:456},fn:x=>x+1})')
					try {
						const native = handleToNative(ctx, ctx.unwrapResult(value), scope)
						expect(native.nested.value).toBe(456)
						expect(native.fn.call(undefined, 2)).toBe(3)
					} finally {
						value.dispose()
					}
					const promise = getHandle(scope, ctx, '', Promise.resolve({ value: 789 }))
					try {
						ctx.setProp(ctx.global, 'promise', promise)
						ctx.evalCode('promise.then(value => { globalThis.received = value })').unwrap().dispose()
						await Bun.sleep(10)
						ctx.runtime.executePendingJobs().dispose()
						const received = ctx.getProp(ctx.global, 'received')
						try {
							expect(ctx.dump(received)).toEqual({ value: 789 })
						} finally {
							received.dispose()
						}
					} finally {
						promise.dispose()
					}
					if (variant.name !== 'ng sync') {
						const asyncCtx = ctx as QuickJSAsyncContext
						const asyncFn = asyncCtx.newAsyncifiedFunction('asyncProbe', async () => {
							await Promise.resolve()
							return ctx.newNumber(333)
						})
						try {
							ctx.setProp(ctx.global, 'asyncProbe', asyncFn)
							const result = await asyncCtx.evalCodeAsync('asyncProbe()')
							try {
								expect(ctx.dump(ctx.unwrapResult(result))).toBe(333)
							} finally {
								result.dispose()
							}
						} finally {
							asyncFn.dispose()
						}
					}
				} finally {
					disposeHostPromises(ctx)
					scope.dispose()
					early.dispose()
					ctx.dispose()
				}
			},
			60_000,
		)
	})
}
