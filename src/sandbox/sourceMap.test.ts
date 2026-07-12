import { describe, expect, it } from 'bun:test'
import { originalPositionFor, parseMappings } from './sourceMap.js'

describe('sourceMap - inline VLQ decoder', () => {
	// Real map emitted by `ts.transpileModule` for a 7-line source whose throw sits on
	// line 6 but lands on emitted line 2 (interface/type/blank lines stripped above).
	const mappings = 'AAIA,MAAM,UAAU,OAAO;IACrB,MAAM,IAAI,KAAK,CAAC,uBAAuB,CAAC,CAAC;AAC3C,CAAC'

	it('maps generated line 2 back to the original source line 6', () => {
		const decoded = parseMappings(mappings)
		expect(originalPositionFor(decoded, 2, 15)).toEqual({ line: 6, column: 12 })
	})

	it('maps a line-only frame (column 0) back to the correct line', () => {
		const decoded = parseMappings(mappings)
		const pos = originalPositionFor(decoded, 2, 0)
		expect(pos?.line).toBe(6)
	})

	it('returns null for an out-of-range generated line', () => {
		const decoded = parseMappings(mappings)
		expect(originalPositionFor(decoded, 99, 0)).toBeNull()
	})

	it('returns null for an empty generated line', () => {
		const decoded = parseMappings('AAAA;;AACA')
		expect(originalPositionFor(decoded, 2, 0)).toBeNull()
	})
})
