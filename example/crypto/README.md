# Crypto Module Example

This example demonstrates how to use Node.js crypto functions within the QuickJS sandbox.

## Features Demonstrated

- **Hash Functions**: SHA256, MD5, and other hash algorithms
- **HMAC**: Hash-based Message Authentication Code
- **Random Generation**: Random bytes and UUIDs
- **Key Derivation**: PBKDF2 and scrypt
- **Encryption/Decryption**: AES, DES, and other cipher algorithms
- **Algorithm Discovery**: List available hashes, ciphers, and curves
- **Timing Safe Comparison**: Constant-time comparison for security

## Running the Example

```bash
npm run example:crypto
```

Or with Deno:

```bash
deno run --allow-all example/crypto/index.ts
```

## Available Crypto Functions

The sandbox provides access to most Node.js crypto functions, including:

### Hashing
- `createHash(algorithm)` - Create a hash object
- `createHmac(algorithm, key)` - Create HMAC object
- `hash(algorithm, data)` - One-shot hash (Node.js 15+)

### Random Data
- `randomBytes(size)` - Generate random bytes
- `randomFillSync(buffer)` - Fill buffer with random data
- `randomFill(buffer, callback)` - Async random fill
- `randomInt(min, max)` - Generate random integer
- `randomUUID()` - Generate RFC 4122 UUID

### Encryption/Decryption
- `createCipheriv(algorithm, key, iv)` - Create cipher
- `createDecipheriv(algorithm, key, iv)` - Create decipher

### Key Derivation
- `pbkdf2(password, salt, iterations, keylen, digest, callback)` - Async PBKDF2
- `pbkdf2Sync(password, salt, iterations, keylen, digest)` - Sync PBKDF2
- `scrypt(password, salt, keylen, options, callback)` - Async scrypt
- `scryptSync(password, salt, keylen, options)` - Sync scrypt
- `hkdf(digest, key, salt, info, keylen, callback)` - HKDF key derivation
- `hkdfSync(digest, key, salt, info, keylen)` - Sync HKDF

### Key Generation
- `generateKey(type, options, callback)` - Generate symmetric key
- `generateKeyPair(type, options, callback)` - Generate key pair
- `generateKeyPairSync(type, options)` - Sync key pair generation

### Public/Private Key Operations
- `publicEncrypt(key, buffer)` - Encrypt with public key
- `publicDecrypt(key, buffer)` - Decrypt with public key
- `privateEncrypt(key, buffer)` - Encrypt with private key
- `privateDecrypt(key, buffer)` - Decrypt with private key

### Digital Signatures
- `createSign(algorithm)` - Create sign object
- `createVerify(algorithm)` - Create verify object
- `sign(algorithm, data, key)` - One-shot signing
- `verify(algorithm, data, key, signature)` - One-shot verification

### Diffie-Hellman
- `createDiffieHellman(sizeOrKey, keyEncoding)` - Create DH object
- `getDiffieHellman(groupName)` - Get predefined DH group
- `createECDH(curveName)` - Create ECDH object

### Utility
- `getCiphers()` - List available cipher algorithms
- `getCurves()` - List available elliptic curves
- `getHashes()` - List available hash algorithms
- `timingSafeEqual(a, b)` - Constant-time buffer comparison

### Key Objects
- `createPublicKey(key)` - Create public key object
- `createPrivateKey(key)` - Create private key object
- `createSecretKey(key)` - Create secret key object

### Web Crypto API
- `webcrypto` - Web Crypto API compatible interface
- `subtle` - SubtleCrypto interface

## Security Notes

All cryptographic operations are performed using the underlying Node.js crypto module, ensuring:
- Industry-standard implementations
- Hardware acceleration when available
- Regular security updates through Node.js
- Constant-time operations for sensitive comparisons

## Example Use Cases

1. **Password Hashing**: Use PBKDF2 or scrypt for secure password storage
2. **API Signatures**: Generate HMAC signatures for API authentication
3. **Data Encryption**: Encrypt sensitive data with AES
4. **Random Tokens**: Generate secure random tokens for sessions
5. **Digital Signatures**: Sign and verify data integrity
6. **Key Exchange**: Perform Diffie-Hellman key exchange
