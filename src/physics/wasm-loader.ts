import wasmBase64 from "./wasm-data";
import workerCode from "./worker-data";

/**
 * Decodes inlined WASM binary data into ArrayBuffer
 */
export function getWasmArrayBuffer(): ArrayBuffer {
	const binaryString = atob(wasmBase64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
}

/**
 * Creates a Blob URL for the physics Web Worker
 */
export function createWorkerBlobUrl(): string {
	const blob = new Blob([workerCode], { type: "text/javascript" });
	return URL.createObjectURL(blob);
}
