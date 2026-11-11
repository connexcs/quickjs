import { describe, expect, it } from 'bun:test'
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
const captureHostFaults = async (fn: () => Promise<unknown>) => {
	const faults: unknown[] = []
	const onFault = (reason: unknown) => {
		faults.push(reason)
	}
	process.on('unhandledRejection', onFault)
	process.on('uncaughtException', onFault)
	try {
		await fn()
		await sleep(150)
	} finally {
		process.off('unhandledRejection', onFault)
		process.off('uncaughtException', onFault)
	}
	return faults
}

const loaders = [
	{ name: 'sync', load: () => loadQuickJs(syncVariant) },
	{ name: 'async', load: () => loadAsyncQuickJs(asyncVariant) },
] as const

for (const loader of loaders) {
	describe(`marshalling security - ${loader.name}`, () => {
		let loaded: ReturnType<typeof loader.load> | undefined
		const run = async (code: string, options: SandboxOptions = {}) => {
			loaded ??= loader.load()
			const { runSandboxed } = await loaded
			return runSandboxed(async ({ evalCode }) => evalCode(code), {
				executionTimeout: 2000,
				memoryLimit: 16 * 1024 * 1024,
				...options,
			})
		}

		describe('late callbacks and disposed handles', () => {
			it('a late fs callback does not crash the host', async () => {
				const faults = await captureHostFaults(async () => {
					const result = await run(
						`import * as fs from 'node:fs'
						fs.writeFileSync('/a.txt', 'x')
						fs.readFile('/a.txt', (e, d) => {})
						await new Promise(r => setTimeout(r, 50))
						export default 'ok'`,
						{ allowFs: true },
					)
					expect(result.ok).toBe(true)
				})
				expect(faults).toEqual([])
			})

			it('a late fs callback firing after the sandbox finished does not crash the host', async () => {
				const faults = await captureHostFaults(async () => {
					const result = await run(
						`import * as fs from 'node:fs'
						fs.writeFileSync('/a.txt', 'x')
						fs.readFile('/a.txt', (e, d) => {})
						export default 'ok'`,
						{ allowFs: true },
					)
					expect(result.ok).toBe(true)
				})
				expect(faults).toEqual([])
			})

			it('JSON.stringify of returned data with a getter does not throw after the sandbox is disposed', async () => {
				const result = await run('export default { get x() { return 1 }, y: 2 }')
				expect(result.ok).toBe(true)
				const data = (result as any).data
				expect(() => JSON.stringify(data)).not.toThrow()
			})

			it('calling a returned guest function after the sandbox finished does not throw', async () => {
				const result = await run('export default { fn: () => 42, get g() { return 1 } }')
				expect(result.ok).toBe(true)
				const data = (result as any).data
				expect(typeof data.fn).toBe('function')
				expect(() => data.fn()).not.toThrow()
				expect(data.fn()).toBeUndefined()
				expect(() => new data.fn()).not.toThrow()
				expect(() => data.g).not.toThrow()
			})
		})

		describe('guest promises passed to host functions', () => {
			it('a rejected guest promise passed to console.log is not an unhandled rejection', async () => {
				const faults = await captureHostFaults(async () => {
					const result = await run(
						`console.log('x', Promise.reject(new Error('guest boom')))
						await new Promise(r => setTimeout(r, 20))
						export default 1`,
						{ console: { log: () => {} } },
					)
					expect(result.ok).toBe(true)
				})
				expect(faults).toEqual([])
			})

			it('a rejected guest promise passed to an ignoring env function is not an unhandled rejection', async () => {
				const faults = await captureHostFaults(async () => {
					const result = await run(
						`env.ignore(Promise.reject(new Error('guest boom')))
						await new Promise(r => setTimeout(r, 20))
						export default 1`,
						{ env: { ignore: (_p: unknown) => {} } },
					)
					expect(result.ok).toBe(true)
				})
				expect(faults).toEqual([])
			})

			it('a guest promise settling after the sandbox finished is not an unhandled rejection', async () => {
				const faults = await captureHostFaults(async () => {
					const result = await run(
						`env.ignore(new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30)))
						export default 1`,
						{ env: { ignore: (_p: unknown) => {} } },
					)
					expect(result.ok).toBe(true)
				})
				expect(faults).toEqual([])
			})

			it('a host function that awaits a rejected guest promise still sees the rejection', async () => {
				let seen: unknown
				const result = await run(
					`await env.consume(Promise.reject(new Error('guest boom')))
					export default 1`,
					{
						env: {
							consume: async (p: Promise<unknown>) => {
								try {
									await p
								} catch (e) {
									seen = e
								}
							},
						},
					},
				)
				expect(result.ok).toBe(true)
				expect((seen as Error)?.message).toBe('guest boom')
			})

			it('a host function that awaits a resolved guest promise receives the value', async () => {
				let seen: unknown
				const result = await run(
					`await env.consume(Promise.resolve({ a: 1 }))
					export default 1`,
					{
						env: {
							consume: async (p: Promise<unknown>) => {
								seen = await p
							},
						},
					},
				)
				expect(result.ok).toBe(true)
				expect(seen).toEqual({ a: 1 })
			})

			it('a rejected module promise still produces ok: false', async () => {
				const result = await run(`throw new Error('top-level boom')`)
				expect(result.ok).toBe(false)
			})
		})

		// The heavier serializer checks only run against the sync loader to keep the suite quick.
		if (loader.name === 'sync') {
			describe('spoofed serializer dispatch', () => {
				it('a spoofed Buffer with a huge length does not allocate host memory', async () => {
					Bun.gc(true)
					const before = process.memoryUsage().rss
					const started = performance.now()
					const result = await run(`
						class Buffer { get buffer() { return { length: 512 * 1024 * 1024 } } }
						export default new Buffer()
					`)
					const elapsed = performance.now() - started
					Bun.gc(true)
					const grown = process.memoryUsage().rss - before
					expect(result.ok).toBe(true)
					const data = (result as any).data
					expect(Buffer.isBuffer(data)).toBe(false)
					expect(grown).toBeLessThan(100 * 1024 * 1024)
					expect(elapsed).toBeLessThan(1500)
				})

				it('a spoofed Buffer with a numeric/array-like buffer does not become a Buffer', async () => {
					const result = await run(`
						class Buffer { get buffer() { return [1, 2, 3] } }
						export default new Buffer()
					`)
					expect(result.ok).toBe(true)
					expect(Buffer.isBuffer((result as any).data)).toBe(false)
				})

				it('a spoofed Buffer with hostile byteOffset/byteLength does not leak or throw', async () => {
					const result = await run(`
						const ab = new ArrayBuffer(8)
						class Buffer {
							get buffer() { return ab }
							get byteOffset() { return -5 }
							get byteLength() { return 1e12 }
						}
						export default new Buffer()
					`)
					expect(result.ok).toBe(true)
					const data = (result as any).data
					expect(data === undefined || typeof data === 'object').toBe(true)
					if (Buffer.isBuffer(data)) expect(data.length).toBeLessThanOrEqual(8)
				})

				it.each([
					['Date', 'Date', `{ getTime() { return 'nope' } }`],
					['Date (throwing)', 'Date', `{ getTime() { throw new Error('x') } }`],
					['URL', 'URL', `{ toJSON() { return 'not a url' } }`],
					['URL (object)', 'URL', '{ toJSON() { return { length: 1e9 } } }'],
					['Headers', 'Headers', `{ forEach(fn) { fn('v', 'bad name') } }`],
					['Headers (many)', 'Headers', `{ forEach(fn) { for (let i = 0; i < 50; i++) fn('v', 'n' + i) } }`],
					['URLSearchParams', 'URLSearchParams', '{ forEach(fn) { fn({}, {}) } }'],
					['Map', 'Map', `{ entries() { throw new Error('x') } }`],
					['Set', 'Set', `{ forEach() { throw new Error('x') } }`],
					['Error', 'Error', `{ get name() { throw new Error('x') } }`],
					['ArrayBuffer', 'ArrayBuffer', '{}'],
				])('a fake %s does not throw out of evalCode', async (_label, name, body) => {
					Bun.gc(true)
					const before = process.memoryUsage().rss
					const result = await run(`
						const Fake = class ${name} ${body}
						export default new Fake()
					`)
					Bun.gc(true)
					expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024)
					expect(result.ok).toBe(true)
				})

				it('a real Buffer round-trips to the right bytes', async () => {
					const result = await run(`export default Buffer.from('hello')`)
					expect(result.ok).toBe(true)
					const data = (result as any).data
					expect(Buffer.isBuffer(data)).toBe(true)
					expect(data.toString()).toBe('hello')
				})

				it('a Buffer view over part of its ArrayBuffer returns only its own window', async () => {
					// A Buffer-named Uint8Array view, as the serializer dispatches on the constructor name.
					const result = await run(`
						const ab = new ArrayBuffer(10)
						new Uint8Array(ab).set([48, 49, 50, 51, 52, 53, 54, 55, 56, 57])
						class Buffer extends Uint8Array {}
						export default new Buffer(ab, 2, 3)
					`)
					expect(result.ok).toBe(true)
					const data = (result as any).data
					expect(Buffer.isBuffer(data)).toBe(true)
					expect(data.toString()).toBe('234')
				})

				it('a real ArrayBuffer still round-trips', async () => {
					const result = await run('export default new Uint8Array([1, 2, 3]).buffer')
					expect(result.ok).toBe(true)
					expect(Array.from((result as any).data)).toEqual([1, 2, 3])
				})

				it('real Date, URL, Map, Set and Headers still round-trip', async () => {
					const result = await run(`
						export default {
							d: new Date(1000),
							u: new URL('https://example.com/a?b=1'),
							m: new Map([['a', 1]]),
							s: new Set([1, 2]),
							h: new Headers({ 'x-a': 'b' }),
						}
					`)
					expect(result.ok).toBe(true)
					const data = (result as any).data
					expect(data.d.getTime()).toBe(1000)
					expect(data.u.href).toBe('https://example.com/a?b=1')
					expect(data.m.get('a')).toBe(1)
					expect(data.s.has(2)).toBe(true)
					expect(data.h.get('x-a')).toBe('b')
				})
			})
		}
	})
}
