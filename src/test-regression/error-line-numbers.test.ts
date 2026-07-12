import { describe, expect, it } from 'bun:test'
import asyncVariant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import syncVariant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadAsyncQuickJs } from '../loadAsyncQuickJs.js'
import { loadQuickJs } from '../loadQuickJs.js'
import type { ErrorResponse } from '../types/ErrorResponse.js'

/**
 * Regression: transpiled TypeScript reported the wrong error line.
 *
 * `getTypescriptSupport` used to transpile with `ts.transpile()` and no source map, so
 * TypeScript's emitter stripped `interface`/`type`/blank lines and shifted every line
 * below them up. QuickJS then reported the emitted-JS line (e.g. 2) instead of the
 * original source line (e.g. 6). The offset is data-dependent, so it is fixed by
 * transpiling with a source map and remapping each guest stack frame.
 */

/** Extract the reported line number for the first frame pointing at `file`. */
const throwLine = (stack: string | undefined, file: string): number | null => {
	if (!stack) return null
	const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const m = stack.match(new RegExp(`\\(${escaped}:(\\d+)`))
	return m ? Number(m[1]) : null
}

const runAsync = async (userCode: string, entry: string, transformTypescript = true) => {
	const { runSandboxed } = await loadAsyncQuickJs(asyncVariant)
	return runSandboxed(async ({ evalCode }) => evalCode(entry), {
		transformTypescript,
		mountFs: { src: { script: userCode } },
	})
}

describe('regression - transpiled TypeScript error line numbers', () => {
	const entry = "import {handler} from './script';\nexport default await handler();"

	it('reports the true source line when type-only lines are stripped (core repro)', async () => {
		const userCode = [
			'interface Foo { a: number }', // 1
			'', // 2
			'type Bar = string;', // 3
			'', // 4
			'export function handler() {', // 5
			'  throw new Error("boom at SOURCE line 6");', // 6
			'}', // 7
		].join('\n')

		const result = (await runAsync(userCode, entry)) as ErrorResponse
		expect(result.ok).toBeFalse()
		expect(result.error.message).toBe('boom at SOURCE line 6')
		expect(throwLine(result.error.stack, '/src/script')).toBe(6)
	})

	it('reports the true line for any number of stripped leading lines (variable offset)', async () => {
		for (const leading of [0, 1, 5, 20]) {
			const typeLines = Array.from({ length: leading }, (_, i) => `type T${i} = string;`)
			const throwLineNo = leading + 2 // function decl on line `leading+1`, throw on next
			const userCode = [
				...typeLines,
				'export function handler() {',
				`  throw new Error("boom at ${throwLineNo}");`,
				'}',
			].join('\n')

			const result = (await runAsync(userCode, entry)) as ErrorResponse
			expect(throwLine(result.error.stack, '/src/script')).toBe(throwLineNo)
		}
	})

	it('handles type-only import elision above the throw', async () => {
		const userCode = [
			"import type { X } from './x';", // 1 (elided)
			'', // 2
			'export function handler() {', // 3
			'  throw new Error("boom");', // 4
			'}', // 5
		].join('\n')

		const result = (await runAsync(userCode, entry)) as ErrorResponse
		expect(throwLine(result.error.stack, '/src/script')).toBe(4)
	})

	it('remaps every frame in a multi-frame stack', async () => {
		const userCode = [
			'type A = number;', // 1
			'', // 2
			'function boom() {', // 3
			'  throw new Error("deep");', // 4
			'}', // 5
			'export function handler() {', // 6
			'  boom();', // 7
			'}', // 8
		].join('\n')

		const result = (await runAsync(userCode, entry)) as ErrorResponse
		expect(result.error.stack).toContain('/src/script:4')
		expect(result.error.stack).toContain('/src/script:7')
	})

	it('reports the true line for an async throw (asyncify path)', async () => {
		const userCode = [
			'type A = number;', // 1
			'', // 2
			'export async function handler() {', // 3
			'  await Promise.resolve();', // 4
			'  throw new Error("async boom");', // 5
			'}', // 6
		].join('\n')

		const result = (await runAsync(userCode, entry)) as ErrorResponse
		expect(result.error.message).toBe('async boom')
		expect(throwLine(result.error.stack, '/src/script')).toBe(5)
	})

	it('uses each file own map for a nested module (per-file keying)', async () => {
		const fileB = [
			'type B = number;', // 1
			'', // 2
			'export function fromB() {', // 3
			'  throw new Error("from B");', // 4
			'}', // 5
		].join('\n')
		const fileA = ["import { fromB } from './b';", '', 'export function handler() {', '  return fromB();', '}'].join(
			'\n',
		)

		const { runSandboxed } = await loadAsyncQuickJs(asyncVariant)
		const result = (await runSandboxed(
			async ({ evalCode }) => evalCode("import {handler} from './script';\nexport default await handler();"),
			{ transformTypescript: true, mountFs: { src: { script: fileA, b: fileB } } },
		)) as ErrorResponse

		expect(result.error.message).toBe('from B')
		expect(throwLine(result.error.stack, '/src/b')).toBe(4)
	})

	// --- Regression cases: must still pass, no rewrite artifacts ---

	it('leaves plain JS (no TypeScript) unchanged', async () => {
		const userCode = ['export function handler() {', '  throw new Error("plain js");', '}'].join('\n')
		const result = (await runAsync(userCode, entry, false)) as ErrorResponse
		expect(result.error.message).toBe('plain js')
		expect(throwLine(result.error.stack, '/src/script')).toBe(2)
	})

	it('is a no-op when TypeScript strips nothing (identity map)', async () => {
		const userCode = [
			'const noop = 1;', // 1
			'export function handler() {', // 2
			'  throw new Error("nothing stripped");', // 3
			'}', // 4
		].join('\n')
		const result = (await runAsync(userCode, entry)) as ErrorResponse
		expect(throwLine(result.error.stack, '/src/script')).toBe(3)
	})

	it('leaves the /src/index.js wrapper frame and Host frames untouched', async () => {
		const userCode = ['type A = number;', '', 'export function handler() {', '  throw new Error("boom");', '}'].join(
			'\n',
		)
		const result = (await runAsync(userCode, entry)) as ErrorResponse
		// entry `export default await handler()` genuinely sits on line 2 - must stay 2.
		expect(throwLine(result.error.stack, '/src/index.js')).toBe(2)
	})

	it('does not throw and returns the fallback shape for a non-Error throw', async () => {
		const userCode = ['type A = number;', '', 'export function handler() {', '  throw "just a string";', '}'].join('\n')
		const result = (await runAsync(userCode, entry)) as ErrorResponse
		expect(result.ok).toBeFalse()
		// A thrown string surfaces as an Error at the boundary; the remap must not crash.
		expect(result.error).toBeDefined()
	})

	it('still flags a genuine SyntaxError', async () => {
		const userCode = ['export function handler() {', '  const x = ;', '}'].join('\n')
		const result = (await runAsync(userCode, entry)) as ErrorResponse
		expect(result.ok).toBeFalse()
		expect(result.error).toBeDefined()
	})

	it('works identically on the sync loader', async () => {
		const userCode = [
			'interface Foo { a: number }', // 1
			'', // 2
			'type Bar = string;', // 3
			'', // 4
			'export function handler() {', // 5
			'  throw new Error("sync boom");', // 6
			'}', // 7
		].join('\n')

		const { runSandboxed } = await loadQuickJs(syncVariant)
		const result = (await runSandboxed(async ({ evalCode }) => evalCode(entry), {
			transformTypescript: true,
			mountFs: { src: { script: userCode } },
		})) as ErrorResponse

		expect(result.error.message).toBe('sync boom')
		expect(throwLine(result.error.stack, '/src/script')).toBe(6)
	})
})
