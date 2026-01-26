import crypto from 'node:crypto'
import type { QuickJSAsyncContext, QuickJSContext, Scope } from 'quickjs-emscripten-core'
import type { RuntimeOptions } from '../../types/RuntimeOptions.js'
import { expose } from '../expose/expose.js'

// Default security limits
const DEFAULT_MAX_RANDOM_BYTES = 65536 // 64KB
const DEFAULT_MAX_PBKDF2_ITERATIONS = 1000000
const DEFAULT_MAX_SCRYPT_COST = 32768
const DEFAULT_MAX_KEY_LENGTH = 1024
const DEFAULT_MAX_HKDF_KEY_LENGTH = 1024

/**
 * Provide Node.js crypto module functions to the sandbox
 */
export const provideCrypto = (
	ctx: QuickJSContext | QuickJSAsyncContext,
	scope: Scope,
	options: RuntimeOptions,
) => {
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
	const maxKeyLength = cryptoConfig.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH
	const maxHkdfKeyLength = cryptoConfig.maxHkdfKeyLength ?? DEFAULT_MAX_HKDF_KEY_LENGTH

	// Wrap crypto functions to handle object serialization across sandbox boundary
	const cryptoFunctions = {
		// Hash - returns hex string directly
		createHashAndDigest: (algorithm: string, data: string | Buffer, outputEncoding: string = 'hex') => {
			const hash = crypto.createHash(algorithm)
			hash.update(data)
			return hash.digest(outputEncoding as crypto.BinaryToTextEncoding)
		},

		// HMAC - returns hex string directly
		createHmacAndDigest: (
			algorithm: string,
			key: string | Buffer,
			data: string | Buffer,
			outputEncoding: string = 'hex',
		) => {
			const hmac = crypto.createHmac(algorithm, key)
			hmac.update(data)
			return hmac.digest(outputEncoding as crypto.BinaryToTextEncoding)
		},

		// Random functions with size limits
		randomBytes: (size: number) => {
			if (size > maxRandomBytes) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: randomBytes size ${size} exceeds maximum ${maxRandomBytes}`)
			}
			if (size < 0) {
				throw new Error('CRYPTO_INVALID_ARG: randomBytes size must be non-negative')
			}
			const buf = crypto.randomBytes(size)
			// Convert to regular Uint8Array for serialization
			return new Uint8Array(buf)
		},

		randomBytesHex: (size: number) => {
			if (size > maxRandomBytes) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: randomBytes size ${size} exceeds maximum ${maxRandomBytes}`)
			}
			if (size < 0) {
				throw new Error('CRYPTO_INVALID_ARG: randomBytes size must be non-negative')
			}
			return crypto.randomBytes(size).toString('hex')
		},

		randomBytesBase64: (size: number) => {
			if (size > maxRandomBytes) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: randomBytes size ${size} exceeds maximum ${maxRandomBytes}`)
			}
			if (size < 0) {
				throw new Error('CRYPTO_INVALID_ARG: randomBytes size must be non-negative')
			}
			return crypto.randomBytes(size).toString('base64')
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
			if (iterations > maxPbkdf2Iterations) {
				throw new Error(
					`CRYPTO_LIMIT_EXCEEDED: pbkdf2 iterations ${iterations} exceeds maximum ${maxPbkdf2Iterations}`,
				)
			}
			if (iterations < 1) {
				throw new Error('CRYPTO_INVALID_ARG: pbkdf2 iterations must be at least 1')
			}
			if (keylen > maxKeyLength) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: key length ${keylen} exceeds maximum ${maxKeyLength}`)
			}
			if (keylen < 1) {
				throw new Error('CRYPTO_INVALID_ARG: key length must be at least 1')
			}
			const key = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest)
			return new Uint8Array(key)
		},

		pbkdf2SyncHex: (
			password: string | Buffer,
			salt: string | Buffer,
			iterations: number,
			keylen: number,
			digest: string,
		) => {
			if (iterations > maxPbkdf2Iterations) {
				throw new Error(
					`CRYPTO_LIMIT_EXCEEDED: pbkdf2 iterations ${iterations} exceeds maximum ${maxPbkdf2Iterations}`,
				)
			}
			if (iterations < 1) {
				throw new Error('CRYPTO_INVALID_ARG: pbkdf2 iterations must be at least 1')
			}
			if (keylen > maxKeyLength) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: key length ${keylen} exceeds maximum ${maxKeyLength}`)
			}
			if (keylen < 1) {
				throw new Error('CRYPTO_INVALID_ARG: key length must be at least 1')
			}
			const key = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest)
			return key.toString('hex')
		},

		scryptSync: (password: string | Buffer, salt: string | Buffer, keylen: number, options?: crypto.ScryptOptions) => {
			const cost = options?.N ?? options?.cost ?? 16384
			if (cost > maxScryptCost) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: scrypt cost ${cost} exceeds maximum ${maxScryptCost}`)
			}
			if (keylen > maxKeyLength) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: key length ${keylen} exceeds maximum ${maxKeyLength}`)
			}
			if (keylen < 1) {
				throw new Error('CRYPTO_INVALID_ARG: key length must be at least 1')
			}
			const key = crypto.scryptSync(password, salt, keylen, options)
			return new Uint8Array(key)
		},

		scryptSyncHex: (
			password: string | Buffer,
			salt: string | Buffer,
			keylen: number,
			options?: crypto.ScryptOptions,
		) => {
			const cost = options?.N ?? options?.cost ?? 16384
			if (cost > maxScryptCost) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: scrypt cost ${cost} exceeds maximum ${maxScryptCost}`)
			}
			if (keylen > maxKeyLength) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: key length ${keylen} exceeds maximum ${maxKeyLength}`)
			}
			if (keylen < 1) {
				throw new Error('CRYPTO_INVALID_ARG: key length must be at least 1')
			}
			const key = crypto.scryptSync(password, salt, keylen, options)
			return key.toString('hex')
		},

		hkdfSync: (
			digest: string,
			key: string | Buffer,
			salt: string | Buffer,
			info: string | Buffer,
			keylen: number,
		) => {
			if (keylen > maxHkdfKeyLength) {
				throw new Error(`CRYPTO_LIMIT_EXCEEDED: HKDF key length ${keylen} exceeds maximum ${maxHkdfKeyLength}`)
			}
			if (keylen < 1) {
				throw new Error('CRYPTO_INVALID_ARG: key length must be at least 1')
			}
			const derivedKey = crypto.hkdfSync(digest, key, salt, info, keylen)
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
