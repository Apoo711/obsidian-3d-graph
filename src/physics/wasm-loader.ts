import wasmBase64 from "./wasm-data";
import workerCode from "./worker-data";

let _cachedWasmBuffer: ArrayBuffer | null = null;

let _cachedWorkerBlobUrl: string | null = null;

export function getWasmArrayBuffer(): ArrayBuffer {
  if (_cachedWasmBuffer === null) {
    const binaryString = atob(wasmBase64);
    const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
    _cachedWasmBuffer = bytes.buffer;
  }
  return _cachedWasmBuffer.slice(0);
}

export function createWorkerBlobUrl(): string {
  if (_cachedWorkerBlobUrl !== null) {
    return _cachedWorkerBlobUrl;
  }
  const blob = new Blob([workerCode], { type: "text/javascript" });
  _cachedWorkerBlobUrl = URL.createObjectURL(blob);
  return _cachedWorkerBlobUrl;
}

export function revokeWorkerBlobUrl(): void {
  if (_cachedWorkerBlobUrl !== null) {
    URL.revokeObjectURL(_cachedWorkerBlobUrl);
    _cachedWorkerBlobUrl = null;
  }
}
