/**
 * Minimal, dependency-free source-map support.
 *
 * TypeScript's emitter strips `interface`/`type` declarations, type-only imports and
 * blank lines when transpiling, so the emitted JS line numbers no longer match the
 * original `.ts` source. QuickJS faithfully reports the emitted-JS line, which means an
 * error thrown on source line 6 can surface as line 2. We fix that by transpiling with a
 * v3 source map and translating each guest stack frame back to its original position.
 *
 * We decode the map ourselves (base64-VLQ) rather than pulling in the `source-map`
 * package: `typescript` is only an optional peer dependency, the package uses an async
 * WASM path that must be explicitly disposed, and we only ever need `originalPositionFor`.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const CHAR_TO_INT: Record<string, number> = {}
for (let i = 0; i < BASE64_CHARS.length; i++) {
	CHAR_TO_INT[BASE64_CHARS[i]] = i
}

const VLQ_CONTINUATION_BIT = 32
const VLQ_VALUE_MASK = 31

/**
 * Decode a single base64-VLQ string into its list of signed integers.
 */
const decodeVLQ = (segment: string): number[] => {
	const result: number[] = []
	let shift = 0
	let value = 0

	for (const char of segment) {
		const integer = CHAR_TO_INT[char]
		// A char outside the base64 alphabet means a malformed map; stop decoding safely.
		if (integer === undefined) {
			break
		}

		const hasContinuation = integer & VLQ_CONTINUATION_BIT
		value += (integer & VLQ_VALUE_MASK) << shift

		if (hasContinuation) {
			shift += 5
		} else {
			const shouldNegate = value & 1
			value >>= 1
			result.push(shouldNegate ? -value : value)
			value = 0
			shift = 0
		}
	}

	return result
}

/**
 * A single mapping segment on a generated line. `srcLine`/`srcCol` are 0-based and
 * absent for segments that only record a generated column (no original mapping).
 */
type Segment = {
	genCol: number
	srcLine?: number
	srcCol?: number
}

/** Decoded mappings: one array of segments per generated line (0-based line index). */
export type DecodedMappings = Segment[][]

/**
 * Decode the `mappings` field of a v3 source map into per-generated-line segments.
 * Segment fields are stored as absolute (already accumulated) values so lookups are O(1)
 * per segment with no further decoding.
 */
export const parseMappings = (mappingsStr: string): DecodedMappings => {
	const lines = mappingsStr.split(';')
	// These accumulate across the whole map (deltas are relative to the previous segment).
	let srcIndex = 0
	let srcLine = 0
	let srcCol = 0
	let nameIndex = 0

	const perLine: DecodedMappings = []

	for (const lineStr of lines) {
		let genCol = 0
		const segments: Segment[] = []

		if (lineStr) {
			for (const segStr of lineStr.split(',')) {
				const fields = decodeVLQ(segStr)
				if (fields.length === 0) {
					continue
				}

				genCol += fields[0]

				if (fields.length >= 4) {
					srcIndex += fields[1]
					srcLine += fields[2]
					srcCol += fields[3]
					segments.push({ genCol, srcLine, srcCol })
				} else {
					segments.push({ genCol })
				}

				if (fields.length >= 5) {
					nameIndex += fields[4]
				}
			}
		}

		perLine.push(segments)
	}

	// Reference the accumulators so they are not flagged as unused; they must persist
	// across lines because deltas are relative to the previous segment in the whole map.
	void srcIndex
	void nameIndex

	return perLine
}

export type OriginalPosition = {
	line: number // 1-based
	column: number // 0-based
}

/**
 * Translate a generated position back to its original source position.
 *
 * @param mappings decoded map (from {@link parseMappings})
 * @param genLine 1-based generated line
 * @param genCol 0-based generated column (pass 0 when the frame carries no column)
 * @returns the original 1-based line and 0-based column, or `null` if unmapped
 */
export const originalPositionFor = (
	mappings: DecodedMappings,
	genLine: number,
	genCol: number,
): OriginalPosition | null => {
	const segments = mappings[genLine - 1]
	if (!segments || segments.length === 0) {
		return null
	}

	// Find the last segment whose generated column is <= the requested column.
	let best: Segment | undefined
	for (const segment of segments) {
		if (segment.srcLine === undefined) {
			continue
		}
		if (segment.genCol <= genCol) {
			best = segment
		} else {
			break
		}
	}

	// If nothing precedes the column, fall back to the first mapped segment on the line.
	if (!best) {
		best = segments.find(s => s.srcLine !== undefined)
	}

	if (!best || best.srcLine === undefined) {
		return null
	}

	return { line: best.srcLine + 1, column: best.srcCol ?? 0 }
}
