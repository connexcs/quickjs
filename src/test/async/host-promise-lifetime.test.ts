import { describe, expect, it, spyOn } from 'bun:test'
import ng from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import sync from '@jitl/quickjs-ng-wasmfile-release-sync'
import legacy from '@jitl/quickjs-wasmfile-release-asyncify'
import { DisposableResult, type QuickJSDeferredPromise, Scope } from 'quickjs-emscripten-core'
import { loadAsyncQuickJs } from '../../loadAsyncQuickJs.js'
import { loadQuickJs } from '../../loadQuickJs.js'
import { getHandle } from '../../sandbox/expose/expose.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

for (const variant of [
	{ name: 'legacy asyncify', load: () => loadAsyncQuickJs(legacy) },
	{ name: 'ng asyncify', load: () => loadAsyncQuickJs(ng) },
	{ name: 'ng sync', load: () => loadQuickJs(sync) },
]) {
	describe(`host-promise lifetime: ${variant.name}`, () => {
		for (const timedOut of [false, true])
			for (const reject of [false, true]) {
				it(`${timedOut ? 'timeout' : 'normal return'} then late ${reject ? 'reject' : 'resolve'}`, async () => {
					const { runSandboxed } = await variant.load()
					const late = deferred<unknown>()
					const gate = deferred<number>()
					const started = deferred<void>()
					const handles: QuickJSDeferredPromise[] = []
					const unhandled: unknown[] = []
					const handler = (error: unknown) => {
						unhandled.push(error)
					}
					process.on('unhandledRejection', handler)
					try {
						const options = { executionTimeout: 5000, env: { late: () => late.promise } }
						const first = await runSandboxed(({ ctx, evalCode }) => {
							// Start the evaluation timeout after sandbox preparation, which can be slow under load.
							ctx.runtime.removeInterruptHandler()
							options.executionTimeout = timedOut ? 150 : 5000
							const original = ctx.newPromise.bind(ctx)
							ctx.newPromise = (...args: unknown[]) => {
								const promise: QuickJSDeferredPromise = Reflect.apply(original, ctx, args)
								handles.push(promise)
								return promise
							}
							return evalCode(timedOut ? 'export default await env.late()' : "env.late(); export default 'done'")
						}, options)
						expect(first.ok).toBe(!timedOut)
						expect(handles.length).toBe(1)
						expect(handles.every(p => !p.alive)).toBe(true)
						const second = runSandboxed(({ evalCode }) => evalCode('export default await env.wait()'), {
							executionTimeout: 5000,
							env: {
								wait: () => {
									started.resolve()
									return gate.promise
								},
							},
						})
						await started.promise
						if (reject) late.reject(new Error('late rejection'))
						else late.resolve({ nested: { value: 123 } })
						await Bun.sleep(10)
						gate.resolve(123)
						expect(await second).toMatchObject({ ok: true, data: 123 })
						expect(await runSandboxed(({ evalCode }) => evalCode('export default 456'))).toMatchObject({
							ok: true,
							data: 456,
						})
						await Bun.sleep(10)
						expect(unhandled).toEqual([])
					} finally {
						process.off('unhandledRejection', handler)
					}
				})
			}

		it('propagates a normal host rejection and keeps resolved objects usable', async () => {
			const { runSandboxed } = await variant.load()
			expect(
				await runSandboxed(({ evalCode }) => evalCode('export default await env.value()'), {
					env: { value: async () => ({ nested: { value: 123 } }) },
				}),
			).toMatchObject({ ok: true, data: { nested: { value: 123 } } })
			expect(
				await runSandboxed(({ evalCode }) => evalCode('export default await env.value()'), {
					env: {
						value: async () => {
							throw new Error('host rejected')
						},
					},
				}),
			).toMatchObject({ ok: false, error: { message: 'host rejected' } })
		})

		it('conversion failure rejects the guest promise without an unhandled host chain', async () => {
			const { runSandboxed } = await variant.load()
			const result = await runSandboxed(({ evalCode }) => evalCode('export default await env.value()'), {
				executionTimeout: 5000,
				env: {
					value: async () =>
						new Proxy(
							{},
							{
								ownKeys() {
									throw new Error('conversion failed')
								},
							},
						),
				},
			})
			expect(result).toMatchObject({ ok: false, error: { message: 'conversion failed' } })
		})
		it('disposes a caller-owned pending-job failure from the settlement kick', async () => {
			const { runSandboxed } = await variant.load()
			const result = await runSandboxed(
				async ({ ctx, evalCode }) => {
					const original = ctx.runtime.executePendingJobs
					const error = ctx.newError('injected pending-job failure')
					let injected = false
					ctx.runtime.executePendingJobs = (...args: Parameters<typeof original>) => {
						if (!injected) {
							injected = true
							return DisposableResult.fail(Object.assign(error, { context: ctx }), () => {})
						}
						return original.apply(ctx.runtime, args)
					}
					try {
						const value = await evalCode('export default await env.value()')
						expect(injected).toBe(true)
						expect(error.alive).toBe(false)
						return value
					} finally {
						ctx.runtime.executePendingJobs = original
						if (error.alive) error.dispose()
					}
				},
				{ executionTimeout: 5000, env: { value: async () => 123 } },
			)
			expect(result).toMatchObject({ ok: true, data: 123 })
		})
		it('conversion failure frees partially constructed object and descriptor handles', async () => {
			const { runSandboxed } = await variant.load()
			const result = await runSandboxed(
				async ({ ctx, evalCode }) => {
					const original = ctx.newObject.bind(ctx)
					const handles: ReturnType<typeof original>[] = []
					ctx.newObject = (...args: Parameters<typeof original>) => {
						const handle = original(...args)
						handles.push(handle)
						return handle
					}
					try {
						const value = await evalCode('export default await env.value()')
						expect(handles.length).toBeGreaterThan(0)
						expect(handles.every(handle => !handle.alive)).toBe(true)
						return value
					} finally {
						ctx.newObject = original
						for (const handle of handles) if (handle.alive) handle.dispose()
					}
				},
				{
					executionTimeout: 5000,
					env: {
						value: async () =>
							new Proxy(
								{},
								{
									ownKeys() {
										throw new Error('conversion failed')
									},
								},
							),
					},
				},
			)
			expect(result).toMatchObject({ ok: false, error: { message: 'conversion failed' } })
		})
		it('keeps nested promises and callable values usable after settlement cleanup', async () => {
			const { runSandboxed } = await variant.load()
			const result = await runSandboxed(
				({ evalCode }) =>
					evalCode(`
				const value = await env.value()
				export default [await value.nested, value.fn(), value.flag, value.unset === undefined]
			`),
				{
					executionTimeout: 5000,
					env: { value: async () => ({ nested: Promise.resolve(123), fn: () => 456, flag: true, unset: undefined }) },
				},
			)
			expect(result).toMatchObject({ ok: true, data: [123, 456, true, true] })
		})
		for (const reject of [false, true]) {
			it(`preserves caller ownership across awaited ${reject ? 'rejection' : 'resolution'}`, async () => {
				const { runSandboxed } = await variant.load()
				await runSandboxed(async ({ ctx }) => {
					const scope = new Scope()
					const input = deferred<unknown>()
					const handle = getHandle(scope, ctx, '', input.promise)
					try {
						if (reject) input.reject('rejected')
						else input.resolve(123)
						await Bun.sleep(10)
						expect(handle.alive).toBe(true)
						expect(() => handle.dispose()).not.toThrow()
					} finally {
						if (handle.alive) handle.dispose()
						scope.dispose()
					}
				})
			})
		}

		it('contains an engine exception thrown by the queued settlement kick', async () => {
			const { runSandboxed } = await variant.load()
			await runSandboxed(async ({ ctx }) => {
				const callbacks: (() => void)[] = []
				const queued = spyOn(globalThis, 'queueMicrotask').mockImplementation(fn => {
					callbacks.push(fn)
				})
				const original = ctx.runtime.executePendingJobs
				const scope = new Scope()
				const input = deferred<unknown>()
				const handle = getHandle(scope, ctx, '', input.promise)
				try {
					input.resolve(123)
					await Promise.resolve()
					expect(callbacks.length).toBeGreaterThan(0)
					let attempted = false
					ctx.runtime.executePendingJobs = () => {
						attempted = true
						throw new Error('engine job failure')
					}
					for (const callback of callbacks) expect(callback).not.toThrow()
					expect(attempted).toBe(true)
				} finally {
					queued.mockRestore()
					ctx.runtime.executePendingJobs = original
					if (handle.alive) handle.dispose()
					scope.dispose()
				}
			})
		})
	})
}
