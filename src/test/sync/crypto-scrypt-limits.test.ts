import { describe, expect, test } from 'bun:test'
import nodeCrypto from 'node:crypto'
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadQuickJs } from '../../loadQuickJs.js'
import type { SandboxOptions } from '../../types/SandboxOptions.js'

type Outcome = { error: boolean; message: string; value?: unknown }

/** Run an expression in the sandbox; returns the thrown message or the value. */
const run = async (expr: string, crypto: SandboxOptions['crypto'] = {}) => {
	const { runSandboxed } = await loadQuickJs(variant)
	const options: SandboxOptions = { allowFs: true, crypto }
	const started = performance.now()
	const result = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
        import crypto from 'node:crypto'
        let out
        try {
          out = { error: false, message: '', value: (${expr}) }
        } catch (e) {
          out = { error: true, message: String(e && e.message) }
        }
        export default out
      `),
		options,
	)
	const elapsed = performance.now() - started
	expect(result.ok).toBe(true)
	if (!result.ok) throw new Error('sandbox failed')
	return { out: result.data as Outcome, elapsed }
}

const scrypt = (opts: string, keylen: number | string = 32) =>
	`crypto.scryptSync('a', 'b', ${keylen}, ${opts}).toString('hex')`

const expectLimit = async (expr: string, crypto?: SandboxOptions['crypto']) => {
	const { out, elapsed } = await run(expr, crypto)
	expect(out.error).toBe(true)
	expect(out.message).toContain('CRYPTO_LIMIT_EXCEEDED')
	expect(elapsed).toBeLessThan(3000)
}

const expectInvalid = async (expr: string) => {
	const { out } = await run(expr)
	expect(out.error).toBe(true)
	expect(out.message).toMatch(/CRYPTO_INVALID_ARG|CRYPTO_LIMIT_EXCEEDED/)
}

describe('scrypt parameter limits', () => {
	test('oversized p is rejected quickly, even with huge maxmem', async () => {
		await expectLimit(scrypt('{ N: 16384, r: 8, p: 2000, maxmem: 2 ** 31 - 1 }'))
	})

	test('oversized r is rejected quickly, even with huge maxmem', async () => {
		await expectLimit(scrypt('{ N: 32768, r: 64, p: 1, maxmem: 2 ** 31 - 1 }'))
	})

	test('alias forms are enforced', async () => {
		await expectLimit(scrypt('{ N: 1024, blockSize: 1000 }'))
		await expectLimit(scrypt('{ N: 1024, parallelization: 1000 }'))
		await expectLimit(scrypt('{ cost: 1048576 }'))
	})

	test('guest maxmem cannot raise limits', async () => {
		await expectLimit(scrypt('{ N: 1024, r: 17, p: 1, maxmem: 2 ** 31 - 1 }'))
		await expectLimit(scrypt('{ N: 1024, r: 8, p: 5, maxmem: 2 ** 31 - 1 }'))
	})

	test('guest maxmem is ignored (small value does not break valid params)', async () => {
		const { out } = await run(scrypt('{ N: 1024, r: 8, p: 1, maxmem: 1 }'))
		expect(out.error).toBe(false)
	})

	test('custom maxScryptBlockSize can be raised and lowered', async () => {
		await expectLimit(scrypt('{ N: 16, r: 20, p: 1 }'))
		const raised = await run(scrypt('{ N: 16, r: 20, p: 1 }'), { maxScryptBlockSize: 32 })
		expect(raised.out.error).toBe(false)
		await expectLimit(scrypt('{ N: 16, r: 8, p: 1 }'), { maxScryptBlockSize: 4 })
	})

	test('custom maxScryptParallelization can be raised and lowered', async () => {
		await expectLimit(scrypt('{ N: 16, r: 1, p: 6 }'))
		const raised = await run(scrypt('{ N: 16, r: 1, p: 6 }'), { maxScryptParallelization: 8 })
		expect(raised.out.error).toBe(false)
		await expectLimit(scrypt('{ N: 16, r: 1, p: 2 }'), { maxScryptParallelization: 1 })
	})

	test('valid parameters match host node:crypto', async () => {
		const { out } = await run(scrypt('{ N: 1024, r: 8, p: 1 }'))
		expect(out.error).toBe(false)
		expect(out.value).toBe(nodeCrypto.scryptSync('a', 'b', 32, { N: 1024, r: 8, p: 1 }).toString('hex'))

		const aliased = await run(scrypt('{ cost: 1024, blockSize: 8, parallelization: 2 }'))
		expect(aliased.out.value).toBe(nodeCrypto.scryptSync('a', 'b', 32, { N: 1024, r: 8, p: 2 }).toString('hex'))
	})

	test('supplying both aliases of a parameter is rejected', async () => {
		const { out } = await run(scrypt('{ N: 1024, cost: 1024 }'))
		expect(out.error).toBe(true)
		expect(out.message).toContain('CRYPTO_INVALID_ARG')
	})
})

describe('strict argument validation', () => {
	const bad = ['"8"', 'NaN', '-1', '0', '1.5', '({})', '[]', 'Infinity', 'null']

	for (const name of ['N', 'r', 'p']) {
		test(`scrypt ${name} rejects invalid values`, async () => {
			for (const v of bad) {
				await expectInvalid(scrypt(`{ N: 16, r: 1, p: 1, ${name}: ${v} }`))
			}
		})
	}

	test('scrypt keylen rejects invalid values', async () => {
		for (const v of ['"32"', 'NaN', '-1', '0', '1.5', '({})', 'Infinity']) {
			await expectInvalid(scrypt('{ N: 16, r: 1, p: 1 }', v))
		}
	})

	test('scrypt options must be an object', async () => {
		await expectInvalid(scrypt('"abc"'))
	})

	test('randomBytes size rejects invalid values', async () => {
		for (const v of ['"8"', 'NaN', '-1', '1.5', '({})', 'Infinity', 'undefined']) {
			await expectInvalid(`crypto.randomBytes(${v}).length`)
		}
	})

	test('randomBytes allows size 0', async () => {
		const { out } = await run('crypto.randomBytes(0).length')
		expect(out.error).toBe(false)
		expect(out.value).toBe(0)
	})

	test('pbkdf2 iterations and keylen reject invalid values', async () => {
		for (const v of ['"1000"', 'NaN', '-1', '0', '1.5', '({})', 'Infinity']) {
			await expectInvalid(`crypto.pbkdf2Sync('p', 's', ${v}, 32, 'sha256')`)
			await expectInvalid(`crypto.pbkdf2Sync('p', 's', 1000, ${v}, 'sha256')`)
		}
	})

	test('hkdf keylen rejects invalid values', async () => {
		for (const v of ['"32"', 'NaN', '-1', '0', '1.5', '({})']) {
			await expectInvalid(`crypto.hkdfSync('sha256', 'k', 's', 'i', ${v})`)
		}
	})
})
