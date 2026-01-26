import { describe, expect, test } from 'bun:test'
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadQuickJs, type SandboxOptions } from '../../index.js'

describe('sync - FormData', () => {
	test('FormData is available in the sandbox', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const result = typeof FormData !== 'undefined';
			export default result;
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result).toEqual({ ok: true, data: true })
	})

	test('FormData append and get work correctly', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const formData = new FormData();
			formData.append('name', 'John');
			formData.append('age', '30');
			export default {
				name: formData.get('name'),
				age: formData.get('age'),
				missing: formData.get('missing')
			};
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result.ok).toBe(true)
		expect((result as any).data.name).toBe('John')
		expect((result as any).data.age).toBe('30')
		expect((result as any).data.missing).toBeNull()
	})

	test('FormData getAll returns all values for a key', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const formData = new FormData();
			formData.append('hobby', 'reading');
			formData.append('hobby', 'coding');
			formData.append('hobby', 'gaming');
			export default formData.getAll('hobby');
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result.ok).toBe(true)
		expect((result as any).data).toEqual(['reading', 'coding', 'gaming'])
	})

	test('FormData set replaces existing values', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const formData = new FormData();
			formData.append('name', 'John');
			formData.append('name', 'Jane');
			formData.set('name', 'Bob');
			export default formData.getAll('name');
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result.ok).toBe(true)
		expect((result as any).data).toEqual(['Bob'])
	})

	test('FormData has checks for key existence', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const formData = new FormData();
			formData.append('exists', 'value');
			export default {
				hasExists: formData.has('exists'),
				hasMissing: formData.has('missing')
			};
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result.ok).toBe(true)
		expect((result as any).data.hasExists).toBe(true)
		expect((result as any).data.hasMissing).toBe(false)
	})

	test('FormData delete removes entries', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const formData = new FormData();
			formData.append('name', 'John');
			formData.append('age', '30');
			formData.delete('name');
			export default {
				hasName: formData.has('name'),
				hasAge: formData.has('age')
			};
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result.ok).toBe(true)
		expect((result as any).data.hasName).toBe(false)
		expect((result as any).data.hasAge).toBe(true)
	})

	test('FormData forEach iterates over entries', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const formData = new FormData();
			formData.append('a', '1');
			formData.append('b', '2');
			const entries = [];
			formData.forEach((value, key) => {
				entries.push(key + ':' + value);
			});
			export default entries;
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result.ok).toBe(true)
		expect((result as any).data).toEqual(['a:1', 'b:2'])
	})

	test('FormData is iterable', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const code = `
			const formData = new FormData();
			formData.append('x', 'one');
			formData.append('y', 'two');
			const entries = [];
			for (const [key, value] of formData) {
				entries.push(key + '=' + value);
			}
			export default entries;
		`

		const result = await runSandboxed(async ({ evalCode }) => {
			return evalCode(code)
		}, {} as SandboxOptions)

		expect(result.ok).toBe(true)
		expect((result as any).data).toEqual(['x=one', 'y=two'])
	})
})
