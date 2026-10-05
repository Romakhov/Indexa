/**
 * Fast non-cryptographic 64-bit content hash (two FNV-1a 32-bit lanes with
 * different seeds), hex-encoded. Used for cache invalidation, not security.
 */
export function contentHash(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193 ^ 0x5bd1e995;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
