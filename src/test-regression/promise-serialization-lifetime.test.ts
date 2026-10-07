import { describe, expect, it } from 'bun:test'
import ng from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import sync from '@jitl/quickjs-ng-wasmfile-release-sync'
import legacy from '@jitl/quickjs-wasmfile-release-asyncify'
import {
	newQuickJSAsyncWASMModuleFromVariant,
	newQuickJSWASMModuleFromVariant,
	type QuickJSHandle,
	Scope,
} from 'quickjs-emscripten-core'
import { handleToNative } from '../sandbox/handleToNative/handleToNative.js'

for (const variant of [
	{ name: 'legacy asyncify', create: () => newQuickJSAsyncWASMModuleFromVariant(legacy) },
	{ name: 'ng asyncify', create: () => newQuickJSAsyncWASMModuleFromVariant(ng) },
	{ name: 'ng sync', create: () => newQuickJSWASMModuleFromVariant(sync) },
]) {
	describe(`promise serialization lifetime - ${variant.name}`, () => {
		for (const reject of [false, true]) {
			it(`releases ${reject ? 'rejected' : 'fulfilled'} promise snapshots`, async () => {
				const module = await variant.create()
				const ctx = module.newContext()
				const observed: QuickJSHandle[] = []
				const getState = ctx.getPromiseState
				ctx.getPromiseState = function (handle) {
					const state = getState.call(this, handle)
					if (!('notAPromise' in state)) {
						if (state.type === 'fulfilled') observed.push(state.value)
						if (state.type === 'rejected') observed.push(state.error)
					}
					return state
				}
				try {
					for (let i = 0; i < 5; i++) {
						const scope = new Scope()
						const result = ctx.evalCode(
							reject ? "Promise.reject(new Error('rejected'))" : 'Promise.resolve({value:123})',
						)
						try {
							const native = handleToNative(ctx, ctx.unwrapResult(result), scope)
							const settlement = Promise.resolve(native).then(
								value => ({ value }),
								error => ({ error }),
							)
							const pump = setInterval(() => ctx.runtime.executePendingJobs().dispose(), 1)
							try {
								const output = await settlement
								if (reject) expect(output).toMatchObject({ error: { message: 'rejected' } })
								else expect(output).toEqual({ value: { value: 123 } })
							} finally {
								clearInterval(pump)
							}
						} finally {
							scope.dispose()
							result.dispose()
						}
					}
					expect(observed).toHaveLength(5)
					expect(observed.filter(handle => handle.alive)).toHaveLength(0)
				} finally {
					for (const handle of observed) if (handle.alive) handle.dispose()
					ctx.getPromiseState = getState
					ctx.dispose()
				}
			})
		}
		it('releases the resolved handle when native conversion throws', async () => {
			const module = await variant.create()
			const ctx = module.newContext()
			const scope = new Scope()
			const result = ctx.evalCode('Promise.resolve({value:123})')
			const originalResolve = ctx.resolvePromise
			const originalTypeof = ctx.typeof
			let delivered: QuickJSHandle | undefined
			ctx.resolvePromise = function (handle) {
				return originalResolve.call(this, handle).then(result => {
					delivered = ctx.unwrapResult(result)
					return result
				})
			}
			ctx.typeof = function (handle) {
				if (handle === delivered) throw new Error('conversion failed')
				return originalTypeof.call(this, handle)
			}
			const pump = setInterval(() => ctx.runtime.executePendingJobs().dispose(), 1)
			try {
				const outcome = await Promise.resolve(handleToNative(ctx, ctx.unwrapResult(result), scope)).then(
					value => ({ value }),
					error => ({ error }),
				)
				expect(outcome).toMatchObject({ error: { message: 'conversion failed' } })
				expect(delivered).toBeDefined()
				expect(delivered?.alive).toBe(false)
			} finally {
				clearInterval(pump)
				ctx.typeof = originalTypeof
				ctx.resolvePromise = originalResolve
				if (delivered?.alive) delivered.dispose()
				scope.dispose()
				result.dispose()
				ctx.dispose()
			}
		})
	})
}
