import { describe, expect, test } from 'bun:test'
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadQuickJs } from '../../loadQuickJs.js'
import type { SandboxOptions } from '../../types/SandboxOptions.js'

describe('Crypto Security Limits', () => {
	test('should enforce maxRandomBytes limit', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
			crypto: {
				maxRandomBytes: 100, // Very small limit for testing
			},
		}

		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          let result = { error: false, message: '' }
          try {
            crypto.randomBytes(200) // Exceeds limit
          } catch (e) {
            result = { error: true, message: e.message }
          }
          export default result
        `),
			options,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) {
			console.log('Unexpected error:', result)
		}
		expect(result.data.error).toBe(true)
		expect(result.data.message).toContain('CRYPTO_LIMIT_EXCEEDED')
		expect(result.data.message).toContain('randomBytes')
	})

	test('should allow randomBytes within limit', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
			crypto: {
				maxRandomBytes: 100,
			},
		}

		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          const bytes = crypto.randomBytes(50)
          export default bytes.length
        `),
			options,
		)

		expect(result.ok).toBe(true)
		expect(result.data).toBe(50)
	})

	test('should enforce maxPbkdf2Iterations limit', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
			crypto: {
				maxPbkdf2Iterations: 1000,
			},
		}

		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          let result = { error: false, message: '' }
          try {
            crypto.pbkdf2Sync('password', 'salt', 5000, 32, 'sha256') // Exceeds limit
          } catch (e) {
            result = { error: true, message: e.message }
          }
          export default result
        `),
			options,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) {
			console.log('Unexpected error:', result)
		}
		expect(result.data.error).toBe(true)
		expect(result.data.message).toContain('CRYPTO_LIMIT_EXCEEDED')
		expect(result.data.message).toContain('pbkdf2')
	})

	test('should enforce maxKeyLength limit', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
			crypto: {
				maxKeyLength: 64,
			},
		}

		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          let result = { error: false, message: '' }
          try {
            crypto.pbkdf2Sync('password', 'salt', 1000, 128, 'sha256') // Key length exceeds limit
          } catch (e) {
            result = { error: true, message: e.message }
          }
          export default result
        `),
			options,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) {
			console.log('Unexpected error:', result)
		}
		expect(result.data.error).toBe(true)
		expect(result.data.message).toContain('CRYPTO_LIMIT_EXCEEDED')
		expect(result.data.message).toContain('key length')
	})

	test('should enforce maxScryptCost limit', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
			crypto: {
				maxScryptCost: 1024,
			},
		}

		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          let result = { error: false, message: '' }
          try {
            crypto.scryptSync('password', 'salt', 32, { N: 16384 }) // Cost exceeds limit
          } catch (e) {
            result = { error: true, message: e.message }
          }
          export default result
        `),
			options,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) {
			console.log('Unexpected error:', result)
		}
		expect(result.data.error).toBe(true)
		expect(result.data.message).toContain('CRYPTO_LIMIT_EXCEEDED')
		expect(result.data.message).toContain('scrypt')
	})

	test('should disable crypto module when enabled is false', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
			crypto: {
				enabled: false,
			},
		}

		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          let result = { error: false, message: '' }
          try {
            crypto.randomBytes(10)
          } catch (e) {
            result = { error: true, message: e.message }
          }
          export default result
        `),
			options,
		)

		// When crypto is disabled, the import itself should fail
		// So result.ok should be false, meaning the script errored
		if (result.ok) {
			// If it somehow succeeded, we expect the crypto call to have thrown
			expect(result.data.error).toBe(true)
			expect(result.data.message).toContain('disabled')
		} else {
			// The import statement itself should have thrown
			expect(JSON.stringify(result)).toContain('disabled')
		}
	})

	test('should use default limits when no crypto options provided', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
			// No crypto options - should use defaults
		}

		// Default maxRandomBytes is 65536, so this should work
		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          const bytes = crypto.randomBytes(1024)
          export default bytes.length
        `),
			options,
		)

		expect(result.ok).toBe(true)
		expect(result.data).toBe(1024)
	})

	test('should reject negative values', async () => {
		const { runSandboxed } = await loadQuickJs(variant)

		const options: SandboxOptions = {
			allowFs: true,
		}

		const result = await runSandboxed(
			async ({ evalCode }) =>
				evalCode(`
          import crypto from 'node:crypto'
          let result = { error: false, message: '' }
          try {
            crypto.randomBytes(-1)
          } catch (e) {
            result = { error: true, message: e.message }
          }
          export default result
        `),
			options,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) {
			console.log('Unexpected error:', result)
		}
		expect(result.data.error).toBe(true)
		expect(result.data.message).toContain('CRYPTO_INVALID_ARG')
	})
})
