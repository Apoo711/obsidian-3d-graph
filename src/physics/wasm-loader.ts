import wasmBase64 from "./wasm-data";
import workerCode from "./worker-data";

// ---------------------------------------------------------------------------
// Module-level caches — decoded once per plugin load, reused on every re-init.
// ---------------------------------------------------------------------------

// WHY: getWasmArrayBuffer() was called on every PhysicsBridge.init(), running
// the full base64 decode + char-by-char loop (O(N) CPU work, ~80 µs for a
// typical 100 KB WASM binary). With caching this becomes a single pointer copy.
let _cachedWasmBuffer: ArrayBuffer | null = null;

// WHY: createWorkerBlobUrl() created a new Blob + URL.createObjectURL on every
// init — neither was ever revoked, causing a steady memory leak. Now we create
// the URL once and revoke it explicitly on plugin unload.
let _cachedWorkerBlobUrl: string | null = null;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Returns the decoded WASM binary as an ArrayBuffer.
 * The result is cached after the first call; subsequent calls are O(1).
 */
export function getWasmArrayBuffer(): ArrayBuffer {
	if (_cachedWasmBuffer !== null) {
		return _cachedWasmBuffer;
	}

	// Use Uint8Array.from with charCodeAt — this path is JIT-friendly and
	// avoids a manual for-loop that the engine can't vectorize as easily.
	const binaryString = atob(wasmBase64);
	const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
	_cachedWasmBuffer = bytes.buffer;
	return _cachedWasmBuffer;
}

/**
 * Returns a stable Blob URL for the physics Web Worker.
 * The URL is created once and reused on subsequent calls.
 * Call {@link revokeWorkerBlobUrl} when the plugin is unloaded.
 */
export function createWorkerBlobUrl(): string {
	if (_cachedWorkerBlobUrl !== null) {
		return _cachedWorkerBlobUrl;
	}
	const blob = new Blob([workerCode], { type: "text/javascript" });
	_cachedWorkerBlobUrl = URL.createObjectURL(blob);
	return _cachedWorkerBlobUrl;
}

/**
 * Revokes the cached Blob URL to free browser resources.
 * Call this from the plugin's `onunload()` handler.
 */
export function revokeWorkerBlobUrl(): void {
	if (_cachedWorkerBlobUrl !== null) {
		URL.revokeObjectURL(_cachedWorkerBlobUrl);
		_cachedWorkerBlobUrl = null;
	}
}
