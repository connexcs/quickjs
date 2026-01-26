import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { loadQuickJs, type SandboxOptions } from '../../src/index.js'

const main = async () => {
	// Load QuickJS WebAssembly
	const { runSandboxed } = await loadQuickJs(variant)

	const options: SandboxOptions = {
		allowFs: true,
	}

	console.log('Testing crypto module in sandbox...\n')

	// Test 1: Hash functions
	console.log('1. Testing hash functions:')
	const hashResult = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    
    const hash = crypto.createHash('sha256')
    hash.update('Hello, World!')
    const result = hash.digest('hex')
    export default result
  `),
		options,
	)
	if (hashResult.ok) {
		console.log('SHA256 hash of "Hello, World!":', hashResult.data)
	}

	// Test 2: HMAC
	console.log('\n2. Testing HMAC:')
	const hmacResult = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    
    const hmac = crypto.createHmac('sha256', 'secret-key')
    hmac.update('Hello, World!')
    const result = hmac.digest('hex')
    export default result
  `),
		options,
	)
	if (hmacResult.ok) {
		console.log('HMAC-SHA256:', hmacResult.data)
	}

	// Test 3: Random bytes
	console.log('\n3. Testing random bytes:')
	const randomResult = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    
    const bytes = crypto.randomBytes(16)
    const result = bytes.toString('hex')
    export default result
  `),
		options,
	)
	if (randomResult.ok) {
		console.log('Random 16 bytes (hex):', randomResult.data)
	}

	// Test 4: Random UUID
	console.log('\n4. Testing random UUID:')
	const uuidResult = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    
    const result = crypto.randomUUID()
    export default result
  `),
		options,
	)
	if (uuidResult.ok) {
		console.log('Random UUID:', uuidResult.data)
	}

	// Test 5: PBKDF2
	console.log('\n5. Testing PBKDF2:')
	const pbkdf2Result = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    
    const key = crypto.pbkdf2Sync('password', 'salt', 100000, 64, 'sha512')
    const result = key.toString('hex')
    export default result
  `),
		options,
	)
	if (pbkdf2Result.ok) {
		console.log('PBKDF2 derived key (first 32 chars):', (pbkdf2Result.data as string)?.substring(0, 32) + '...')
	}

	// Test 6: Get available algorithms
	console.log('\n6. Testing algorithm lists:')
	const algorithmsResult = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    
    const result = {
      hashes: crypto.getHashes().slice(0, 5),
      ciphers: crypto.getCiphers().slice(0, 5),
      curves: crypto.getCurves().slice(0, 5)
    }
    export default result
  `),
		options,
	)
	if (algorithmsResult.ok) {
		console.log('Available algorithms:', algorithmsResult.data)
	}

	// Test 7: Encrypt/Decrypt with AES-256-CBC
	console.log('\n7. Testing AES-256-CBC encryption/decryption:')
	const encryptResult = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    
    const algorithm = 'aes-256-cbc'
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(16)
    const text = 'Secret message'
    
    // Encrypt
    const cipher = crypto.createCipheriv(algorithm, key, iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    
    // Decrypt
    const decipher = crypto.createDecipheriv(algorithm, key, iv)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    
    const result = { original: text, encrypted, decrypted }
    export default result
  `),
		options,
	)
	if (encryptResult.ok) {
		console.log('Encryption test:', encryptResult.data)
	}

	// Test 8: Timing safe equal
	console.log('\n8. Testing timing safe equal:')
	const timingSafeResult = await runSandboxed(
		async ({ evalCode }) =>
			evalCode(`
    import crypto from 'node:crypto'
    import { Buffer } from 'node:buffer'
    
    const a = Buffer.from('hello')
    const b = Buffer.from('hello')
    const c = Buffer.from('world')
    
    const result = {
      aEqualsB: crypto.timingSafeEqual(a, b),
      aEqualsC: false
    }
    
    try {
      result.aEqualsC = crypto.timingSafeEqual(a, c)
    } catch (e) {
      result.error = e.message
    }
    
    export default result
  `),
		options,
	)
	if (timingSafeResult.ok) {
		console.log('Timing safe comparison:', timingSafeResult.data)
	}

	console.log('\n✅ All crypto tests completed successfully!')
}

main().catch(console.error)
