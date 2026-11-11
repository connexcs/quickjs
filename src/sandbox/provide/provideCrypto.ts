import crypto from 'node:crypto'
import type { QuickJSAsyncContext, QuickJSContext, Scope } from 'quickjs-emscripten-core'
import type { RuntimeOptions } from '../../types/RuntimeOptions.js'
import { expose } from '../expose/expose.js'

// Default security limits
const DEFAULT_MAX_RANDOM_BYTES = 65536 // 64KB
const DEFAULT_MAX_PBKDF2_ITERATIONS = 1000000
const DEFAULT_MAX_SCRYPT_COST = 32768
const DEFAULT_MAX_SCRYPT_BLOCK_SIZE = 16
const DEFAULT_MAX_SCRYPT_PARALLELIZATION = 4
const SCRYPT_MIN_MAXMEM = 32 * 1024 * 1024 // node's default maxmem
const SCRYPT_MAXMEM_MARGIN = 1024 * 1024

/**
 * Strictly validate a guest-supplied integer. Rejects non-numbers, NaN, Infinity and fractions
 * (CRYPTO_INVALID_ARG), values below min (CRYPTO_INVALID_ARG) and values above max (CRYPTO_LIMIT_EXCEEDED).
 */
const checkInt = (value: unknown, label: string, min: number, max: number): number => {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new Error(`CRYPTO_INVALID_ARG: ${label} must be an integer`)
	}
	if (value < min) {
		throw new Error(`CRYPTO_INVALID_ARG: ${label} must be ${min === 0 ? 'non-negative' : `at least ${min}`}`)
	}
	if (value > max) {
		throw new Error(`CRYPTO_LIMIT_EXCEEDED: ${label} ${value} exceeds maximum ${max}`)
	}
	if (!Number.isSafeInteger(value)) {
		throw new Error(`CRYPTO_INVALID_ARG: ${label} must be a safe integer`)
	}
	return value
}

/** Read a parameter that has two aliases; supplying both is an error (as in node). */
const pickAlias = (opts: Record<string, unknown>, a: string, b: string, fallback: number): unknown => {
	if (opts[a] !== undefined && opts[b] !== undefined) {
		throw new Error(`CRYPTO_INVALID_ARG: scrypt options ${a} and ${b} cannot both be specified`)
	}
	const value = opts[a] !== undefined ? opts[a] : opts[b]
	return value === undefined ? fallback : value
}

const DEFAULT_MAX_KEY_LENGTH = 1024
const DEFAULT_MAX_HKDF_KEY_LENGTH = 1024

/**
 * Provide Node.js crypto module functions to the sandbox
 */
export const provideCrypto = (ctx: QuickJSContext | QuickJSAsyncContext, scope: Scope, options: RuntimeOptions) => {
	// Get crypto configuration with defaults
	const cryptoConfig = options.crypto || {}

	// Check if crypto is disabled
	if (cryptoConfig.enabled === false) {
		expose(ctx, scope, {
			__crypto: {
				disabled: true,
			},
		})
		return
	}

	// Apply security limits
	const maxRandomBytes = cryptoConfig.maxRandomBytes ?? DEFAULT_MAX_RANDOM_BYTES
	const maxPbkdf2Iterations = cryptoConfig.maxPbkdf2Iterations ?? DEFAULT_MAX_PBKDF2_ITERATIONS
	const maxScryptCost = cryptoConfig.maxScryptCost ?? DEFAULT_MAX_SCRYPT_COST
	const maxScryptBlockSize = cryptoConfig.maxScryptBlockSize ?? DEFAULT_MAX_SCRYPT_BLOCK_SIZE
	const maxScryptParallelization = cryptoConfig.maxScryptParallelization ?? DEFAULT_MAX_SCRYPT_PARALLELIZATION
	const maxKeyLength = cryptoConfig.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH
	const maxHkdfKeyLength = cryptoConfig.maxHkdfKeyLength ?? DEFAULT_MAX_HKDF_KEY_LENGTH

	const checkPbkdf2 = (iterations: unknown, keylen: unknown): [number, number] => [
		checkInt(iterations, 'pbkdf2 iterations', 1, maxPbkdf2Iterations),
		checkInt(keylen, 'key length', 1, maxKeyLength),
	]

	// Validated scrypt: guest options are never forwarded. Only validated N/r/p are read,
	// and maxmem is computed host-side from them.
	const runScrypt = (
		password: string | Buffer,
		salt: string | Buffer,
		keylen: unknown,
		guestOptions: unknown,
	): Buffer => {
		if (guestOptions !== undefined && guestOptions !== null && typeof guestOptions !== 'object') {
			throw new Error('CRYPTO_INVALID_ARG: scrypt options must be an object')
		}
		const opts = (guestOptions ?? {}) as Record<string, unknown>
		const N = checkInt(pickAlias(opts, 'N', 'cost', 16384), 'scrypt cost', 1, maxScryptCost)
		const r = checkInt(pickAlias(opts, 'r', 'blockSize', 8), 'scrypt block size', 1, maxScryptBlockSize)
		const p = checkInt(
			pickAlias(opts, 'p', 'parallelization', 1),
			'scrypt parallelization',
			1,
			maxScryptParallelization,
		)
		const len = checkInt(keylen, 'key length', 1, maxKeyLength)
		const maxmem = Math.max(SCRYPT_MIN_MAXMEM, 128 * r * (N + 2 + p) + SCRYPT_MAXMEM_MARGIN)
		return crypto.scryptSync(password, salt, len, { N, r, p, maxmem })
	}

	// Wrap crypto functions to handle object serialization across sandbox boundary
	const cryptoFunctions = {
		// Hash - returns hex string directly
		createHashAndDigest: (algorithm: string, data: string | Buffer, outputEncoding = 'hex') => {
			const hash = crypto.createHash(algorithm)
			hash.update(data)
			return hash.digest(outputEncoding as crypto.BinaryToTextEncoding)
		},

		// HMAC - returns hex string directly
		createHmacAndDigest: (algorithm: string, key: string | Buffer, data: string | Buffer, outputEncoding = 'hex') => {
			const hmac = crypto.createHmac(algorithm, key)
			hmac.update(data)
			return hmac.digest(outputEncoding as crypto.BinaryToTextEncoding)
		},

		// Random functions with size limits
		randomBytes: (size: number) => {
			const n = checkInt(size, 'randomBytes size', 0, maxRandomBytes)
			// Convert to regular Uint8Array for serialization
			return new Uint8Array(crypto.randomBytes(n))
		},

		randomBytesHex: (size: number) => {
			return crypto.randomBytes(checkInt(size, 'randomBytes size', 0, maxRandomBytes)).toString('hex')
		},

		randomBytesBase64: (size: number) => {
			return crypto.randomBytes(checkInt(size, 'randomBytes size', 0, maxRandomBytes)).toString('base64')
		},

		randomUUID: () => {
			return crypto.randomUUID()
		},

		randomInt: (...args: Parameters<typeof crypto.randomInt>) => {
			return crypto.randomInt(...args)
		},

		// Key derivation with limits
		pbkdf2Sync: (
			password: string | Buffer,
			salt: string | Buffer,
			iterations: number,
			keylen: number,
			digest: string,
		) => {
			const [iter, len] = checkPbkdf2(iterations, keylen)
			return new Uint8Array(crypto.pbkdf2Sync(password, salt, iter, len, digest))
		},

		pbkdf2SyncHex: (
			password: string | Buffer,
			salt: string | Buffer,
			iterations: number,
			keylen: number,
			digest: string,
		) => {
			const [iter, len] = checkPbkdf2(iterations, keylen)
			return crypto.pbkdf2Sync(password, salt, iter, len, digest).toString('hex')
		},

		scryptSync: (password: string | Buffer, salt: string | Buffer, keylen: number, options?: unknown) => {
			return new Uint8Array(runScrypt(password, salt, keylen, options))
		},

		scryptSyncHex: (password: string | Buffer, salt: string | Buffer, keylen: number, options?: unknown) => {
			return runScrypt(password, salt, keylen, options).toString('hex')
		},

		hkdfSync: (digest: string, key: string | Buffer, salt: string | Buffer, info: string | Buffer, keylen: number) => {
			const len = checkInt(keylen, 'HKDF key length', 1, maxHkdfKeyLength)
			const derivedKey = crypto.hkdfSync(digest, key, salt, info, len)
			return new Uint8Array(derivedKey)
		},

		// Encryption/Decryption - simplified interface
		encryptAES256CBC: (plaintext: string, key: Buffer | Uint8Array, iv: Buffer | Uint8Array) => {
			const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv))
			let encrypted = cipher.update(plaintext, 'utf8', 'hex')
			encrypted += cipher.final('hex')
			return encrypted
		},

		decryptAES256CBC: (ciphertext: string, key: Buffer | Uint8Array, iv: Buffer | Uint8Array) => {
			const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv))
			let decrypted = decipher.update(ciphertext, 'hex', 'utf8')
			decrypted += decipher.final('utf8')
			return decrypted
		},

		// Generic cipher operations
		encrypt: (
			algorithm: string,
			plaintext: string,
			key: Buffer | Uint8Array,
			iv: Buffer | Uint8Array,
			inputEncoding: BufferEncoding = 'utf8',
			outputEncoding: BufferEncoding = 'hex',
		) => {
			const cipher = crypto.createCipheriv(algorithm, Buffer.from(key), Buffer.from(iv))
			let encrypted = cipher.update(plaintext, inputEncoding, outputEncoding)
			encrypted += cipher.final(outputEncoding)
			return encrypted
		},

		decrypt: (
			algorithm: string,
			ciphertext: string,
			key: Buffer | Uint8Array,
			iv: Buffer | Uint8Array,
			inputEncoding: BufferEncoding = 'hex',
			outputEncoding: BufferEncoding = 'utf8',
		) => {
			const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), Buffer.from(iv))
			let decrypted = decipher.update(ciphertext, inputEncoding, outputEncoding)
			decrypted += decipher.final(outputEncoding)
			return decrypted
		},

		// Utility functions
		getCiphers: () => {
			return crypto.getCiphers()
		},

		getCurves: () => {
			return crypto.getCurves()
		},

		getHashes: () => {
			return crypto.getHashes()
		},

		timingSafeEqual: (a: Buffer | Uint8Array, b: Buffer | Uint8Array) => {
			return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
		},

		// Constants
		getConstants: () => {
			return crypto.constants
		},
	}

	expose(ctx, scope, {
		__crypto: cryptoFunctions,
	})
}
