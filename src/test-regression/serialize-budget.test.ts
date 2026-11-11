import { beforeAll, describe, expect, it } from 'bun:test'
import asyncVariant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import syncVariant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadAsyncQuickJs } from '../loadAsyncQuickJs.js'
import { loadQuickJs } from '../loadQuickJs.js'
import type { SandboxOptions } from '../types/SandboxOptions.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Runs `fn` while capturing any host-level unhandled rejection / uncaught exception, waits a
 * little for stragglers, and returns what was captured.
 */
const captureHostFaults = async <T>(fn: () => Promise<T>) => {
	const faults: unknown[] = []
	const onFault = (reason: unknown) => {
		faults.push(reason)
	}
	process.on('unhandledRejection', onFault)
	process.on('uncaughtException', onFault)
	let value: T
	try {
		value = await fn()
		await sleep(150)
	} finally {
		process.off('unhandledRejection', onFault)
		process.off('uncaughtException', onFault)
	}
	return { faults, value }
}

const TIMEOUT = 5000
const BUDGET_MESSAGE = /exceeds the maximum serialized size/
const baseOptions: SandboxOptions = { memoryLimit: 32 * 1024 * 1024, executionTimeout: TIMEOUT }

const expectBudgetFailure = (result: { ok: boolean; error?: { name: string; message: string } }) => {
	expect(result.ok).toBe(false)
	expect(result.error?.name).toBe('RangeError')
	expect(result.error?.message).toMatch(BUDGET_MESSAGE)
	expect(result.error?.message).toContain('maxSerializedSize')
}

const rssMb = () => process.memoryUsage().rss / 1024 / 1024

describe('serialize budget - sync', () => {
	let loaded: ReturnType<typeof loadQuickJs> | undefined
	const run = async (code: string, options: SandboxOptions = {}) => {
		loaded ??= loadQuickJs(syncVariant)
		const { runSandboxed } = await loaded
		return runSandboxed(async ({ evalCode }) => evalCode(code), { ...baseOptions, ...options })
	}

	beforeAll(async () => {
		loaded = loadQuickJs(syncVariant)
		await loaded
	})

	describe('amplification via repeated references', () => {
		it('rejects Array(N).fill(bigString) quickly without allocating a lot of host memory', async () => {
			const before = rssMb()
			const started = Date.now()
			const { faults, value: result } = await captureHostFaults(() =>
				run(`export default Array(1500).fill('x'.repeat(200000))`),
			)
			const elapsed = Date.now() - started
			const growth = rssMb() - before
			expectBudgetFailure(result as any)
			expect(elapsed).toBeLessThan(2500)
			expect(growth).toBeLessThan(150)
			expect(faults).toEqual([])
		})

		it('rejects a large Buffer referenced many times', async () => {
			const result = await run(`
				const b = Buffer.alloc(1024 * 1024, 1)
				export default Array(100).fill(b)
			`)
			expectBudgetFailure(result as any)
		})

		it('rejects a large ArrayBuffer referenced many times', async () => {
			const result = await run(`
				const b = new ArrayBuffer(1024 * 1024)
				export default Array(100).fill(b)
			`)
			expectBudgetFailure(result as any)
		})
	})

	describe('huge array lengths', () => {
		it('rejects new Array(2**32-1)', async () => {
			const result = await run('export default new Array(2 ** 32 - 1)')
			expectBudgetFailure(result as any)
		})

		it('rejects a sparse array with length 1e9', async () => {
			const result = await run('const a = []; a.length = 1e9; export default a')
			expectBudgetFailure(result as any)
		})
	})

	describe('endless forEach loops', () => {
		const loopBudget = async (code: string) => {
			const started = Date.now()
			const { faults, value: result } = await captureHostFaults(() => run(code))
			const elapsed = Date.now() - started
			expectBudgetFailure(result as any)
			expect(elapsed).toBeLessThan(TIMEOUT / 2)
			expect(faults).toEqual([])
		}

		it('terminates a patched Map.prototype.forEach with a look-alike', async () => {
			await loopBudget(`
				Map.prototype.forEach = function (fn) { let i = 0; for (;;) fn('v', 'k' + i++) }
				export default { constructor: { name: 'Map' } }
			`)
		})

		it('terminates a patched Map.prototype.forEach with a real Map', async () => {
			await loopBudget(`
				Map.prototype.forEach = function (fn) { let i = 0; for (;;) fn('k' + i++, 'v') }
				export default new Map([[1, 2]])
			`)
		})

		it('terminates a patched Set.prototype.forEach with a look-alike', async () => {
			await loopBudget(`
				Set.prototype.forEach = function (fn) { let i = 0; for (;;) fn('v' + i++) }
				export default { constructor: { name: 'Set' } }
			`)
		})

		it('terminates a patched Set.prototype.forEach with a real Set', async () => {
			await loopBudget(`
				Set.prototype.forEach = function (fn) { let i = 0; for (;;) fn('v' + i++) }
				export default new Set([1])
			`)
		})

		it('terminates a Headers look-alike with an endless forEach', async () => {
			await loopBudget(`
				const big = 'v'.repeat(1000)
				export default { constructor: { name: 'Headers' }, forEach(fn) { let i = 0; for (;;) fn(big, 'n' + i++) } }
			`)
		})

		it('terminates a URLSearchParams look-alike with an endless forEach', async () => {
			await loopBudget(`
				const big = 'v'.repeat(1000)
				export default { constructor: { name: 'URLSearchParams' }, forEach(fn) { let i = 0; for (;;) fn(big, 'n' + i++) } }
			`)
		})
	})

	describe('guest to host arguments', () => {
		it('never calls the host function for an over-budget argument and the guest can catch the error', async () => {
			let calls = 0
			const { faults, value: result } = await captureHostFaults(() =>
				run(
					`let caught
					try { env.fn(Array(1500).fill('x'.repeat(200000))) } catch (e) { caught = { name: e.name, message: e.message } }
					export default caught`,
					{
						env: {
							fn: () => {
								calls++
							},
						},
					},
				),
			)
			expect(result.ok).toBe(true)
			const caught = (result as any).data
			expect(caught.message).toMatch(BUDGET_MESSAGE)
			expect(calls).toBe(0)
			expect(faults).toEqual([])
		})

		it('charges a top-level over-budget string argument and leaves no stale error behind', async () => {
			let calls = 0
			const result = await run(
				`let caught
				try { env.fn('x'.repeat(10 * 1024 * 1024)) } catch (e) { caught = e.message }
				// an unrelated, ordinary host failure must not be reported as the stale budget error
				let other
				try { env.boom() } catch (e) { other = e.message }
				export default { caught, other }`,
				{
					memoryLimit: 64 * 1024 * 1024,
					env: {
						fn: () => {
							calls++
						},
						boom: () => {
							throw new Error('plain host failure')
						},
					},
				},
			)
			expect(result.ok).toBe(true)
			const data = (result as any).data
			expect(data.caught).toMatch(BUDGET_MESSAGE)
			expect(data.other).toContain('plain host failure')
			expect(data.other).not.toMatch(BUDGET_MESSAGE)
			expect(calls).toBe(0)
		})

		it('charges all arguments of one call together', async () => {
			let calls = 0
			const result = await run(
				`const big = 'x'.repeat(200000)
				let caught
				try { env.fn(...Array(200).fill(big)) } catch (e) { caught = e.message }
				export default caught`,
				{
					env: {
						fn: () => {
							calls++
						},
					},
				},
			)
			expect(result.ok).toBe(true)
			expect((result as any).data).toMatch(BUDGET_MESSAGE)
			expect(calls).toBe(0)
		})

		it('does not share the budget between separate calls', async () => {
			let calls = 0
			const result = await run(
				`const big = 'x'.repeat(200000)
				for (let i = 0; i < 100; i++) env.fn(big)
				export default 'done'`,
				{
					env: {
						fn: () => {
							calls++
						},
					},
				},
			)
			expect(result.ok).toBe(true)
			expect(calls).toBe(100)
		})
	})

	describe('configurable limit', () => {
		const mbString = `export default 'x'.repeat(3 * 1024 * 1024)`

		it('rejects a modest result under a small limit', async () => {
			const result = await run(mbString, { memoryLimit: 64 * 1024 * 1024, maxSerializedSize: 1024 * 1024 })
			expectBudgetFailure(result as any)
			expect((result as any).error.message).toContain(`${1024 * 1024} bytes`)
		})

		it('accepts the same result under a larger limit', async () => {
			const result = await run(mbString, { memoryLimit: 64 * 1024 * 1024, maxSerializedSize: 64 * 1024 * 1024 })
			expect(result.ok).toBe(true)
			expect((result as any).data.length).toBe(3 * 1024 * 1024)
		})

		it('disables the check with 0', async () => {
			const result = await run(
				`export default ['x'.repeat(200000), 'y'.repeat(200000)].concat(Array(120).fill('z'.repeat(200000)))`,
				{ memoryLimit: 64 * 1024 * 1024, maxSerializedSize: 0 },
			)
			expect(result.ok).toBe(true)
			expect((result as any).data.length).toBe(122)
		})

		it('rejects the 0-vs-default payload under the default limit', async () => {
			const result = await run(
				`export default ['x'.repeat(200000), 'y'.repeat(200000)].concat(Array(120).fill('z'.repeat(200000)))`,
				{ memoryLimit: 64 * 1024 * 1024 },
			)
			expectBudgetFailure(result as any)
		})
	})

	describe('default limit accepts legitimate payloads', () => {
		it('accepts a ~4 MB string', async () => {
			const result = await run(`export default 'x'.repeat(4 * 1024 * 1024)`, { memoryLimit: 64 * 1024 * 1024 })
			expect(result.ok).toBe(true)
			expect((result as any).data.length).toBe(4 * 1024 * 1024)
		})

		it('accepts an array of 50,000 small objects', async () => {
			const result = await run(`export default Array.from({ length: 50000 }, (_, i) => ({ id: i, name: 'n' + i }))`, {
				memoryLimit: 128 * 1024 * 1024,
				executionTimeout: 120000,
			})
			expect(result.ok).toBe(true)
			expect((result as any).data.length).toBe(50000)
			expect((result as any).data[49999]).toEqual({ id: 49999, name: 'n49999' })
		}, 150000)
	})

	describe('recovery', () => {
		it('keeps working after a budget failure on the same loader', async () => {
			const failed = await run(`export default Array(1500).fill('x'.repeat(200000))`)
			expectBudgetFailure(failed as any)
			const failedLength = await run('export default new Array(2 ** 32 - 1)')
			expectBudgetFailure(failedLength as any)
			const ok = await run(`export default { a: [1, 2, 3], s: 'fine' }`)
			expect(ok.ok).toBe(true)
			expect((ok as any).data).toEqual({ a: [1, 2, 3], s: 'fine' })
		})

		it('keeps working after an endless-loop failure', async () => {
			const failed = await run(`
				Map.prototype.forEach = function (fn) { let i = 0; for (;;) fn('k' + i++, 'v') }
				export default new Map([[1, 2]])
			`)
			expectBudgetFailure(failed as any)
			const ok = await run('export default new Map([[1, 2]])')
			expect(ok.ok).toBe(true)
			expect((ok as any).data).toEqual(new Map([[1, 2]]))
		})
	})
})

describe('serialize budget - async', () => {
	let loaded: ReturnType<typeof loadAsyncQuickJs> | undefined
	const run = async (code: string, options: SandboxOptions = {}) => {
		loaded ??= loadAsyncQuickJs(asyncVariant)
		const { runSandboxed } = await loaded
		return runSandboxed(async ({ evalCode }) => evalCode(code), { ...baseOptions, ...options })
	}

	it('rejects Array(N).fill(bigString) quickly without allocating a lot of host memory', async () => {
		await run('export default 1') // warm up the module before measuring
		const before = rssMb()
		const started = Date.now()
		const { faults, value: result } = await captureHostFaults(() =>
			run(`export default Array(1500).fill('x'.repeat(200000))`),
		)
		expectBudgetFailure(result as any)
		expect(Date.now() - started).toBeLessThan(2500)
		expect(rssMb() - before).toBeLessThan(150)
		expect(faults).toEqual([])
	})

	it('rejects over-budget arguments, never calls the host function and charges arguments together', async () => {
		let calls = 0
		const { faults, value: result } = await captureHostFaults(() =>
			run(
				`const big = 'x'.repeat(200000)
				let a, b
				try { env.fn(Array(1500).fill(big)) } catch (e) { a = e.message }
				try { env.fn(...Array(200).fill(big)) } catch (e) { b = e.message }
				export default { a, b }`,
				{
					env: {
						fn: () => {
							calls++
						},
					},
				},
			),
		)
		expect(result.ok).toBe(true)
		expect((result as any).data.a).toMatch(BUDGET_MESSAGE)
		expect((result as any).data.b).toMatch(BUDGET_MESSAGE)
		expect(calls).toBe(0)
		expect(faults).toEqual([])
	})

	it('keeps working after a budget failure', async () => {
		const failed = await run('export default new Array(2 ** 32 - 1)')
		expectBudgetFailure(failed as any)
		const ok = await run('export default { a: [1, 2, 3] }')
		expect(ok.ok).toBe(true)
		expect((ok as any).data).toEqual({ a: [1, 2, 3] })
	})
})
