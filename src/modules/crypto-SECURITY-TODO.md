# Crypto Module Security Enhancements TODO

This document outlines security improvements needed for the crypto module before production use.

---

## 🔴 High Priority

### 1. Resource Exhaustion Protection

**Issue**: No limits on expensive crypto operations that could cause DoS.

**Tasks**:
- [ ] Add `maxRandomBytes` limit (default: 65536 / 64KB)
- [ ] Add `maxPbkdf2Iterations` limit (default: 1,000,000)
- [ ] Add `maxScryptCost` limit (default: 32768)
- [ ] Add `maxKeyLength` limit (default: 1024 bytes)
- [ ] Add `maxHkdfKeyLength` limit (default: 1024 bytes)

**Implementation Location**: `src/sandbox/provide/provideCrypto.ts`

```typescript
// Example implementation
const cryptoConfig = options.crypto || {}
const maxRandomBytes = cryptoConfig.maxRandomBytes || 65536

randomBytesHex: (size: number) => {
  if (size > maxRandomBytes) {
    throw new Error(`Random bytes size ${size} exceeds maximum ${maxRandomBytes}`)
  }
  return crypto.randomBytes(size).toString('hex')
}
```

---

### 2. Algorithm Whitelisting

**Issue**: Weak/deprecated algorithms (MD4, MD5, DES) are exposed.

**Tasks**:
- [ ] Create default whitelist of safe algorithms
- [ ] Add `allowedHashAlgorithms` config option
- [ ] Add `allowedCipherAlgorithms` config option
- [ ] Add `allowedCurves` config option
- [ ] Validate algorithms before use

**Default Safe Algorithms**:
```typescript
const SAFE_HASHES = ['sha256', 'sha384', 'sha512', 'sha3-256', 'sha3-384', 'sha3-512']
const SAFE_CIPHERS = [
  'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc',
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
  'chacha20-poly1305'
]
const SAFE_CURVES = ['prime256v1', 'secp384r1', 'secp521r1']
```

---

### 3. Input Validation

**Issue**: No validation of inputs to crypto functions.

**Tasks**:
- [ ] Validate key sizes match algorithm requirements
- [ ] Validate IV sizes match algorithm requirements
- [ ] Validate encoding parameters are supported values
- [ ] Validate salt lengths for key derivation
- [ ] Add descriptive error messages for validation failures

**Key Size Requirements**:
| Algorithm | Key Size (bytes) | IV Size (bytes) |
|-----------|------------------|-----------------|
| aes-128-* | 16 | 16 (CBC) / 12 (GCM) |
| aes-192-* | 24 | 16 (CBC) / 12 (GCM) |
| aes-256-* | 32 | 16 (CBC) / 12 (GCM) |
| chacha20-poly1305 | 32 | 12 |

---

## 🟡 Medium Priority

### 4. RuntimeOptions Extension

**Issue**: No way for users to configure crypto security settings.

**Tasks**:
- [ ] Add `crypto` option to `RuntimeOptions` interface
- [ ] Document all crypto configuration options
- [ ] Add sensible defaults
- [ ] Allow complete disabling of crypto module

**Proposed Interface**:
```typescript
interface CryptoOptions {
  enabled?: boolean // Default: true
  
  // Resource limits
  maxRandomBytes?: number
  maxPbkdf2Iterations?: number
  maxScryptCost?: number
  maxKeyLength?: number
  
  // Algorithm restrictions
  allowedHashAlgorithms?: string[]
  allowedCipherAlgorithms?: string[]
  allowedCurves?: string[]
  
  // Security modes
  enforceStrongAlgorithms?: boolean // Default: false
  allowWeakAlgorithms?: boolean // Default: true (for backwards compat)
}
```

---

### 5. Error Handling Security

**Issue**: Crypto errors may leak sensitive information.

**Tasks**:
- [ ] Sanitize error messages before returning to sandbox
- [ ] Remove stack traces from crypto errors
- [ ] Avoid including key material in error messages
- [ ] Add generic error codes for common failures

**Example**:
```typescript
try {
  return crypto.createDecipheriv(algorithm, key, iv)
} catch (err) {
  // Don't expose: "Invalid key length"
  // Instead throw: new Error('CRYPTO_DECRYPTION_FAILED')
  throw new Error('CRYPTO_DECRYPTION_FAILED')
}
```

---

### 6. Rate Limiting

**Issue**: No protection against rapid repeated crypto operations.

**Tasks**:
- [ ] Add optional `maxOperationsPerSecond` config
- [ ] Track crypto operation count per sandbox instance
- [ ] Implement sliding window rate limiting
- [ ] Add configurable penalty/backoff for exceeded limits

---

## 🟢 Low Priority

### 7. Audit Logging

**Issue**: No visibility into crypto operations for security auditing.

**Tasks**:
- [ ] Add optional crypto operation logging callback
- [ ] Log algorithm usage (without sensitive data)
- [ ] Track operation counts and timing
- [ ] Enable detection of suspicious patterns

---

### 8. Authenticated Encryption (AEAD)

**Issue**: Current implementation focuses on CBC mode without authentication.

**Tasks**:
- [ ] Add `createCipherivGCM` / `createDecipherivGCM` functions
- [ ] Handle authentication tags properly
- [ ] Add `encrypt` / `decrypt` helper functions with built-in authentication
- [ ] Document preference for authenticated encryption

---

### 9. Secure Key Handling

**Issue**: Keys are handled as plain objects/arrays.

**Tasks**:
- [ ] Implement secure key object wrapper
- [ ] Prevent key serialization/logging
- [ ] Add key zeroing after use (best effort)
- [ ] Document secure key handling practices

---

### 10. Documentation

**Tasks**:
- [ ] Document all security considerations in README
- [ ] Add security best practices section
- [ ] Document resource limit defaults and recommendations
- [ ] Add examples of secure configuration
- [ ] Warn about sandbox bypass for CPU-bound operations

---

## Testing Requirements

### Security Tests to Add

- [ ] Test resource limit enforcement
- [ ] Test algorithm whitelist enforcement
- [ ] Test input validation for all functions
- [ ] Test error message sanitization
- [ ] Test rate limiting (if implemented)
- [ ] Fuzz testing for edge cases
- [ ] Memory consumption tests

---

## Notes

### Sandbox Bypass Consideration

Crypto operations inherently execute in the host runtime, bypassing:
- QuickJS memory limits
- QuickJS execution time limits
- QuickJS stack limits

This is by design but should be clearly documented. Resource limits in the crypto module help mitigate abuse.

### Backwards Compatibility

When implementing security enhancements:
- Default behavior should remain permissive for dev/testing
- Add `enforceStrongAlgorithms: true` for production mode
- Deprecate weak algorithms with warnings before removal
- Version bump appropriately for breaking changes

---

## References

- [Node.js Crypto Security Considerations](https://nodejs.org/api/crypto.html#crypto-security-considerations)
- [OWASP Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/)
- [NIST Cryptographic Standards](https://csrc.nist.gov/projects/cryptographic-standards-and-guidelines)
