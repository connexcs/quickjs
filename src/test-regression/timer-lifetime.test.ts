import { describe, expect, it } from 'bun:test'
import ng from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import sync from '@jitl/quickjs-ng-wasmfile-release-sync'
import legacy from '@jitl/quickjs-wasmfile-release-asyncify'
import {
	DisposableResult,
	newQuickJSAsyncWASMModuleFromVariant,
	newQuickJSWASMModuleFromVariant,
	type QuickJSAsyncContext,
	type QuickJSContext,
	type QuickJSHandle,
} from 'quickjs-emscripten-core'
import { loadAsyncQuickJs } from '../loadAsyncQuickJs.js'
import { loadQuickJs } from '../loadQuickJs.js'
import { provideTimingFunctions } from '../sandbox/provide/provideTimingFunctions.js'

const variants = [
	{ name: 'sync', create: () => newQuickJSWASMModuleFromVariant(sync), load: () => loadQuickJs(sync) },
	{ name: 'ng asyncify', create: () => newQuickJSAsyncWASMModuleFromVariant(ng), load: () => loadAsyncQuickJs(ng) },
	{
		name: 'legacy asyncify',
		create: () => newQuickJSAsyncWASMModuleFromVariant(legacy),
		load: () => loadAsyncQuickJs(legacy),
	},
]

async function withTimers(
	variant: (typeof variants)[number],
	run: (
		ctx: QuickJSContext | QuickJSAsyncContext,
		timers: ReturnType<typeof provideTimingFunctions>,
		copies: QuickJSHandle[],
		results: ReturnType<QuickJSContext['callFunction']>[],
		argumentCopies: QuickJSHandle[],
	) => Promise<void>,
	max = { maxTimeoutCount: 100, maxIntervalCount: 100 },
) {
	const module = await variant.create()
	const runtime = module.newRuntime()
	const ctx = runtime.newContext()
	const copies: QuickJSHandle[] = []
	const argumentCopies: QuickJSHandle[] = []
	const results: ReturnType<typeof ctx.callFunction>[] = []
	const newFunction = ctx.newFunction
	ctx.newFunction = function (name, fn) {
		return newFunction.call(this, name, function (...args) {
			if (
				['setTimeout', 'setInterval', 'setImmediate'].includes(name) &&
				args[0] &&
				ctx.typeof(args[0]) === 'function'
			) {
				for (const [index, arg] of args.entries()) {
					const dup = arg.dup
					Object.defineProperty(arg, 'dup', {
						value: function () {
							const copy: QuickJSHandle = Reflect.apply(dup, this, [])
							if (index === 0) copies.push(copy)
							else if (ctx.typeof(arg) !== 'boolean' && ctx.typeof(arg) !== 'undefined' && ctx.typeof(arg) !== 'null')
								argumentCopies.push(copy)
							return copy
						},
					})
				}
			}
			return fn.apply(this, args)
		})
	}
	const callFunction = ctx.callFunction
	ctx.callFunction = function (...args: unknown[]) {
		const result: ReturnType<QuickJSContext['callFunction']> = Reflect.apply(callFunction, this, args)
		results.push(result)
		return result
	}
	const timers = provideTimingFunctions(ctx, max)
	try {
		await run(ctx, timers, copies, results, argumentCopies)
	} finally {
		for (const result of results) if (result.alive) result.dispose()
		timers.dispose()
		ctx.dispose()
		runtime.dispose()
	}
}

for (const variant of variants) {
	describe(`timer lifetime - ${variant.name}`, () => {
		it('releases completed/cancelled callbacks and successful/error results within a live context', async () => {
			await withTimers(variant, async (ctx, timers, copies, results) => {
				ctx
					.unwrapResult(
						ctx.evalCode(`
					for (let i = 0; i < 10; i++) { const t = setTimeout(() => {}, 100); clearTimeout(t); }
					for (let i = 0; i < 10; i++) setTimeout(() => {}, 1);
					setTimeout(() => { throw new Error('uncaught timer failure'); }, 1);
				`),
					)
					.dispose()
				await Bun.sleep(40)
				expect(copies).toHaveLength(21)
				expect(results.length).toBeGreaterThanOrEqual(11)
				expect(copies.filter(h => h.alive)).toHaveLength(0)
				expect(results.filter(r => r.alive)).toHaveLength(0)
				expect((await timers.failure).message).toBe('uncaught timer failure')
			})
		})

		it('releases cancelled immediates and intervals immediately', async () => {
			await withTimers(variant, async (ctx, _timers, copies, results) => {
				ctx
					.unwrapResult(
						ctx.evalCode(`
					globalThis.called = 0
					for (let i = 0; i < 20; i++) {
						const immediate = setImmediate(() => called++)
						clearImmediate(immediate); clearImmediate(immediate)
						const interval = setInterval(() => called++, 1)
						clearInterval(interval); clearInterval(interval)
					}
				`),
					)
					.dispose()
				expect(copies).toHaveLength(40)
				expect(copies.filter(h => h.alive)).toHaveLength(0)
				await Bun.sleep(20)
				expect(
					ctx
						.evalCode('called')
						.unwrap()
						.consume(h => ctx.dump(h)),
				).toBe(0)
				expect(results).toHaveLength(0)
			})
		})

		it('keeps an interval callback alive during self-cancellation and releases it on return', async () => {
			await withTimers(variant, async (ctx, _timers, copies, results) => {
				let probes = 0
				const probe = ctx.newFunction('probe', () => {
					probes++
					expect(copies[0].alive).toBe(true)
				})
				try {
					ctx.setProp(ctx.global, 'probe', probe)
					ctx.unwrapResult(ctx.evalCode('const id = setInterval(() => { clearInterval(id); probe() }, 1)')).dispose()
					expect(copies[0].alive).toBe(true)
					await Bun.sleep(30)
					expect(probes).toBe(1)
					expect(copies[0].alive).toBe(false)
					expect(results.filter(r => r.alive)).toHaveLength(0)
				} finally {
					probe.dispose()
				}
			})
		})

		it('teardown cancels all timer kinds and can be repeated', async () => {
			await withTimers(variant, async (ctx, timers, copies, results) => {
				ctx
					.unwrapResult(
						ctx.evalCode(`
					setTimeout(() => {}, 20)
					setInterval(() => {}, 20)
					setImmediate(() => {})
				`),
					)
					.dispose()
				expect(copies.filter(h => h.alive)).toHaveLength(3)
				timers.dispose()
				timers.dispose()
				expect(copies.filter(h => h.alive)).toHaveLength(0)
				await Bun.sleep(30)
				expect(results).toHaveLength(0)
			})
		})

		it('bounds retention across repeated batches in the same context', async () => {
			await withTimers(variant, async (ctx, _timers, copies, results) => {
				for (let batch = 0; batch < 5; batch++) {
					ctx.unwrapResult(ctx.evalCode('for (let i = 0; i < 20; i++) setImmediate(() => ({value:123}))')).dispose()
					expect(copies.filter(h => h.alive)).toHaveLength(20)
					await Bun.sleep(20)
					expect(copies.filter(h => h.alive)).toHaveLength(0)
					expect(results.filter(r => r.alive)).toHaveLength(0)
				}
				expect(copies).toHaveLength(100)
			})
		})

		it('enforces the immediate limit and releases capacity after cancellation', async () => {
			await withTimers(
				variant,
				async (ctx, _timers, copies) => {
					ctx
						.unwrapResult(
							ctx.evalCode(`
					const id = setImmediate(() => {})
					try { setImmediate(() => {}); throw new Error('limit not enforced') }
					catch (e) { if (!e.message.includes('exceeds the limit')) throw e }
					clearImmediate(id)
					clearImmediate(setImmediate(() => {}))
				`),
						)
						.dispose()
					expect(copies).toHaveLength(2)
					expect(copies.filter(h => h.alive)).toHaveLength(0)
				},
				{ maxTimeoutCount: 1, maxIntervalCount: 1 },
			)
		})

		it('observes returned async rejections and releases all callback results', async () => {
			await withTimers(variant, async (ctx, timers, copies, results) => {
				ctx
					.unwrapResult(
						ctx.evalCode(
							"setTimeout(async () => { await Promise.resolve(); throw new TypeError('async timer failure') }, 1)",
						),
					)
					.dispose()
				await Bun.sleep(20)
				ctx.runtime.executePendingJobs().dispose()
				const error = await timers.failure
				expect(error.name).toBe('TypeError')
				expect(error.message).toBe('async timer failure')
				expect(copies.filter(h => h.alive)).toHaveLength(0)
				expect(results.filter(r => r.alive)).toHaveLength(0)
			})
		})
		it('supports teardown during a timer invocation without freeing its active callback', async () => {
			await withTimers(variant, async (ctx, timers, copies, results) => {
				let stopped = false
				const stop = ctx.newFunction('stop', () => {
					timers.dispose()
					expect(copies[0].alive).toBe(true)
					stopped = true
				})
				try {
					ctx.setProp(ctx.global, 'stop', stop)
					ctx.unwrapResult(ctx.evalCode('setInterval(() => stop(), 1)')).dispose()
					await Bun.sleep(30)
					expect(stopped).toBe(true)
					expect(copies.filter(h => h.alive)).toHaveLength(0)
					expect(results.filter(r => r.alive)).toHaveLength(0)
				} finally {
					stop.dispose()
				}
			})
		})

		it('ignores a returned promise rejection after provider teardown', async () => {
			await withTimers(variant, async (ctx, timers, copies, results) => {
				ctx
					.unwrapResult(
						ctx.evalCode('setImmediate(() => new Promise((_, reject) => { globalThis.rejectTimer = reject }))'),
					)
					.dispose()
				await Bun.sleep(20)
				timers.dispose()
				const dump = ctx.dump
				let lateDumps = 0
				ctx.dump = function (handle) {
					lateDumps++
					return dump.call(this, handle)
				}
				try {
					ctx.unwrapResult(ctx.evalCode("rejectTimer(new Error('late'))")).dispose()
					ctx.runtime.executePendingJobs().dispose()
					expect(lateDumps).toBe(0)
					expect(copies.filter(h => h.alive)).toHaveLength(0)
					expect(results.filter(r => r.alive)).toHaveLength(0)
				} finally {
					ctx.dump = dump
				}
			})
		})

		for (const kind of ['setTimeout', 'setImmediate', 'setInterval']) {
			for (const asynchronous of [false, true]) {
				it(`reports ${kind} ${asynchronous ? 'async rejection' : 'throw'} through evalCode`, async () => {
					const { runSandboxed } = await variant.load()
					const result = await runSandboxed(
						({ evalCode }) =>
							evalCode(`
						${kind}(${asynchronous ? 'async' : ''} () => {
							${asynchronous ? 'await Promise.resolve()' : ''}
							throw new TypeError('timer failed')
						}, 1)
						export default await new Promise(() => {})
					`),
						{ executionTimeout: 5000 },
					)
					expect(result).toMatchObject({ ok: false, error: { name: 'TypeError', message: 'timer failed' } })
					expect(await runSandboxed(({ evalCode }) => evalCode('export default 123'))).toMatchObject({
						ok: true,
						data: 123,
					})
				})
			}
		}
		it('clear functions cancel IDs belonging to other timer kinds', async () => {
			await withTimers(variant, async (ctx, _timers, copies, results) => {
				ctx
					.unwrapResult(
						ctx.evalCode(`
					clearTimeout(setInterval(() => { throw new Error('not cancelled') }, 1))
					clearInterval(setTimeout(() => { throw new Error('not cancelled') }, 1))
					clearTimeout(setImmediate(() => { throw new Error('not cancelled') }))
					clearTimeout(); clearInterval(); clearImmediate()
				`),
					)
					.dispose()
				expect(copies.filter(h => h.alive)).toHaveLength(0)
				await Bun.sleep(20)
				expect(results).toHaveLength(0)
			})
		})

		it('reports descriptive errors for missing and non-function callbacks', async () => {
			await withTimers(variant, async ctx => {
				for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
					for (const args of ['', '123', 'undefined']) {
						const result = ctx.evalCode(`${name}(${args})`)
						try {
							expect(result.error).toBeDefined()
							if (result.error)
								expect(ctx.dump(result.error)).toMatchObject({
									name: 'TypeError',
									message: `${name} callback must be a function`,
								})
						} finally {
							result.dispose()
						}
					}
				}
			})
		})

		it('passes extra arguments to every timer kind, including self-cancelling intervals', async () => {
			await withTimers(variant, async (ctx, _timers, copies, results, argumentCopies) => {
				ctx
					.unwrapResult(
						ctx.evalCode(`
					globalThis.values = []
					setTimeout((obj, text, flag) => values.push([obj.value,text,flag]), 1, {value:1}, 'timeout', false)
					setImmediate((obj, text, flag) => values.push([obj.value,text,flag]), {value:2}, 'immediate', false)
					const id = setInterval((obj, text, flag) => { clearTimeout(id); values.push([obj.value,text,flag]) }, 1, {value:3}, 'interval', false)
				`),
					)
					.dispose()
				await Bun.sleep(30)
				const values = ctx
					.evalCode('values')
					.unwrap()
					.consume(h => ctx.dump(h))
				expect(values).toHaveLength(3)
				for (const expected of [
					[1, 'timeout', false],
					[2, 'immediate', false],
					[3, 'interval', false],
				])
					expect(values).toContainEqual(expected)
				expect(argumentCopies.length).toBeGreaterThan(0)
				expect(argumentCopies.filter(h => h.alive)).toHaveLength(0)
				expect(copies.filter(h => h.alive)).toHaveLength(0)
				expect(results.filter(r => r.alive)).toHaveLength(0)
			})
		})

		it('retains the first failure when several callbacks fail', async () => {
			await withTimers(variant, async (ctx, timers, _copies, results) => {
				ctx
					.unwrapResult(
						ctx.evalCode(
							"setImmediate(() => {throw new Error('first')}); setImmediate(() => {throw new Error('second')})",
						),
					)
					.dispose()
				await Bun.sleep(20)
				expect((await timers.failure).message).toBe('first')
				expect(results.filter(r => r.alive)).toHaveLength(0)
			})
		})

		it('reports and disposes pending-job errors', async () => {
			await withTimers(variant, async (ctx, timers) => {
				const error = ctx.newError('job failed')
				const original = ctx.runtime.executePendingJobs
				ctx.runtime.executePendingJobs = () => DisposableResult.fail(Object.assign(error, { context: ctx }), () => {})
				try {
					timers.executePendingJobs()
					expect(error.alive).toBe(false)
					expect((await timers.failure).message).toBe('job failed')
				} finally {
					ctx.runtime.executePendingJobs = original
					if (error.alive) error.dispose()
				}
			})
		})

		it('keeps timeout and immediate capacity independent', async () => {
			await withTimers(
				variant,
				async (ctx, _timers, copies) => {
					ctx
						.unwrapResult(
							ctx.evalCode(
								'const timeout=setTimeout(()=>{},100); const immediate=setImmediate(()=>{}); clearTimeout(timeout); clearImmediate(immediate)',
							),
						)
						.dispose()
					expect(copies).toHaveLength(2)
					expect(copies.filter(h => h.alive)).toHaveLength(0)
				},
				{ maxTimeoutCount: 1, maxIntervalCount: 1 },
			)
		})
		it('returns a pending-job failure from evalCode and frees the error handle', async () => {
			const { runSandboxed } = await variant.load()
			const result = await runSandboxed(
				async ({ ctx, evalCode }) => {
					const original = ctx.runtime.executePendingJobs
					const error = ctx.newError('event loop failed')
					ctx.runtime.executePendingJobs = () => DisposableResult.fail(Object.assign(error, { context: ctx }), () => {})
					try {
						const result = await evalCode('export default await new Promise(() => {})')
						expect(error.alive).toBe(false)
						return result
					} finally {
						ctx.runtime.executePendingJobs = original
						if (error.alive) error.dispose()
					}
				},
				{ executionTimeout: 5000 },
			)
			expect(result).toMatchObject({ ok: false, error: { message: 'event loop failed' } })
		})
	})
}
