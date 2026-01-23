export default `
import { Buffer } from 'node:buffer'

// Access crypto functions from the host runtime
const hostCrypto = globalThis.__crypto

if (!hostCrypto) {
  throw new Error('Node.js crypto module is not available in the host runtime')
}

// Hash functions - returns object with update/digest methods for API compatibility
export const createHash = (algorithm) => {
  let dataBuffer = ''
  
  return {
    update: function(data, encoding) {
      dataBuffer += data
      return this
    },
    digest: (encoding = 'hex') => {
      return hostCrypto.createHashAndDigest(algorithm, dataBuffer, encoding)
    },
  }
}

export const createHmac = (algorithm, key) => {
  let dataBuffer = ''
  
  return {
    update: function(data, encoding) {
      dataBuffer += data
      return this
    },
    digest: (encoding = 'hex') => {
      return hostCrypto.createHmacAndDigest(algorithm, key, dataBuffer, encoding)
    },
  }
}

// Random functions  
export const randomBytes = (size) => {
  // Return hex string directly, then wrap it
  const hexString = hostCrypto.randomBytesHex(size)
  
  // Convert hex string to array for accessing individual bytes
  const bytes = []
  for (let i = 0; i < size; i++) {
    bytes.push(parseInt(hexString.substr(i * 2, 2), 16))
  }
  
  // Return plain object that acts like Buffer
  return {
    length: size,
    0: bytes[0],
    ...Object.fromEntries(bytes.map((b, i) => [i, b])),
    toString: (encoding = 'hex') => {
      if (encoding === 'hex') {
        return hexString
      }
      throw new Error('Unsupported encoding: ' + encoding)
    }
  }
}

export const randomUUID = () => {
  return hostCrypto.randomUUID()
}

export const randomInt = (...args) => {
  return hostCrypto.randomInt(...args)
}

// Key derivation functions
export const pbkdf2Sync = (password, salt, iterations, keylen, digest) => {
  const hexResult = hostCrypto.pbkdf2SyncHex(password, salt, iterations, keylen, digest)
  const size = hexResult.length / 2
  const bytes = []
  for (let i = 0; i < size; i++) {
    bytes.push(parseInt(hexResult.substr(i * 2, 2), 16))
  }
  
  // Return plain object  
  return {
    length: size,
    ...Object.fromEntries(bytes.map((b, i) => [i, b])),
    toString: (encoding = 'hex') => {
      if (encoding === 'hex') {
        return hexResult
      }
      throw new Error('Unsupported encoding: ' + encoding)
    }
  }
}

export const scryptSync = (password, salt, keylen, options) => {
  const hexResult = hostCrypto.scryptSyncHex(password, salt, keylen, options)
  const size = hexResult.length / 2
  const bytes = []
  for (let i = 0; i < size; i++) {
    bytes.push(parseInt(hexResult.substr(i * 2, 2), 16))
  }
  
  // Return plain object
  return {
    length: size,
    ...Object.fromEntries(bytes.map((b, i) => [i, b])),
    toString: (encoding = 'hex') => {
      if (encoding === 'hex') {
        return hexResult
      }
      throw new Error('Unsupported encoding: ' + encoding)
    }
  }
}

export const hkdfSync = (digest, key, salt, info, keylen) => {
  const arr = hostCrypto.hkdfSync(digest, key, salt, info, keylen)
  return new Uint8Array(arr)
}

// Cipher functions
export const createCipheriv = (algorithm, key, iv, options) => {
  const operations = {
    data: '',
    inputEnc: 'utf8',
    outputEnc: 'hex'
  }
  
  return {
    update: function(data, inputEncoding, outputEncoding) {
      operations.data += data
      if (inputEncoding) operations.inputEnc = inputEncoding
      if (outputEncoding) operations.outputEnc = outputEncoding
      return ''  // Return empty string to match Node.js behavior
    },
    final: (outputEncoding) => {
      if (outputEncoding) operations.outputEnc = outputEncoding
      return hostCrypto.encrypt(algorithm, operations.data, key, iv, operations.inputEnc, operations.outputEnc)
    },
    setAutoPadding: function(autoPadding) {
      return this
    },
  }
}

export const createDecipheriv = (algorithm, key, iv, options) => {
  const operations = {
    data: '',
    inputEnc: 'hex',
    outputEnc: 'utf8'
  }
  
  return {
    update: function(data, inputEncoding, outputEncoding) {
      operations.data += data
      if (inputEncoding) operations.inputEnc = inputEncoding
      if (outputEncoding) operations.outputEnc = outputEncoding
      return ''  // Return empty string to match Node.js behavior
    },
    final: (outputEncoding) => {
      if (outputEncoding) operations.outputEnc = outputEncoding
      return hostCrypto.decrypt(algorithm, operations.data, key, iv, operations.inputEnc, operations.outputEnc)
    },
    setAutoPadding: function(autoPadding) {
      return this
    },
  }
}

// Utility functions
export const getCiphers = () => {
  return hostCrypto.getCiphers()
}

export const getCurves = () => {
  return hostCrypto.getCurves()
}

export const getHashes = () => {
  return hostCrypto.getHashes()
}

export const timingSafeEqual = (a, b) => {
  return hostCrypto.timingSafeEqual(a, b)
}

// Constants
export const constants = hostCrypto.getConstants()

// Default export with all methods
export default {
  // Hash
  createHash,
  createHmac,
  
  // Random
  randomBytes,
  randomUUID,
  randomInt,
  
  // Key derivation
  pbkdf2Sync,
  scryptSync,
  hkdfSync,
  
  // Cipher
  createCipheriv,
  createDecipheriv,
  
  // Utility
  getCiphers,
  getCurves,
  getHashes,
  timingSafeEqual,
  
  // Constants
  constants,
}
`
