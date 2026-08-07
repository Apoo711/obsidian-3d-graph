import { WorkerIncomingMessage, WorkerOutgoingMessage } from "./physics-types";

// ---------------------------------------------------------------------------
// Worker bootstrap — this file is bundled into worker-data.ts by the build
// script and executed inside a dedicated Web Worker context.
// ---------------------------------------------------------------------------

declare const require: any;

// ---- WASM instance references -----------------------------------------------

let wasmInstance: any = null;
let physicsWasm: any = null;
let nodeCount = 0;

// ---- Communication strategy -------------------------------------------------
//
// Fast path  (crossOriginIsolated / Electron with COI):
//   Allocate a SharedArrayBuffer once.  On each STEP the worker writes WASM
//   positions directly into the SAB; the main thread reads from the same
//   memory with zero copies and zero transfers.
//
// Fallback path (no SharedArrayBuffer):
//   Ping-pong double-buffer: the worker pre-allocates a Float32Array, copies
//   WASM positions into it with Float32Array.set() (a single memcpy), and
//   transfers the underlying ArrayBuffer to the main thread (zero-copy move).
//   The main thread returns the ArrayBuffer in a RETURN_BUFFER message so the
//   worker can reuse it on the next tick — eliminating per-tick GC pressure.

/** Positions stride in f32 units — Vec3A layout: x, y, z, _pad. */
const POSITION_STRIDE = 4 as const;

// SAB fast path
let sharedView: Float32Array | null = null;

// Ping-pong fallback — holds the ArrayBuffer returned by the main thread.
let pingPongBuffer: ArrayBuffer | null = null;

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<WorkerIncomingMessage>) => {
	const msg = event.data;

	try {
		switch (msg.type) {
			// ----------------------------------------------------------------
			case "INIT": {
				nodeCount = msg.nodeCount;
				const floatCount = nodeCount * POSITION_STRIDE;

				// Initialise the compiled WASM module via wasm-bindgen glue.
				const initWasm = require(
					"../../crates/graph-physics/pkg/graph_physics.js",
				);
				wasmInstance = initWasm.initSync({ module: msg.wasmBytes });
				physicsWasm = new initWasm.GraphPhysicsWasm(
					msg.nodeCount,
					msg.edgesFlat,
					msg.params || {},
				);

				if (msg.initialPositions) {
					physicsWasm.set_positions(msg.initialPositions);
				}

				// Detect SharedArrayBuffer support (requires crossOriginIsolated
				// or Electron with the right flags).
				if (typeof SharedArrayBuffer !== "undefined") {
					// ---- SAB fast path ----
					const sab = new SharedArrayBuffer(
						floatCount * Float32Array.BYTES_PER_ELEMENT,
					);
					sharedView = new Float32Array(sab);

					(self as any).postMessage({
						type: "READY",
						sharedBuffer: sab,
						positionsStride: POSITION_STRIDE,
						nodeCount,
					} as WorkerOutgoingMessage);
				} else {
					// ---- Ping-pong fallback ----
					// Pre-allocate the first output buffer so the first STEP
					// message requires no allocation.
					pingPongBuffer = new ArrayBuffer(
						floatCount * Float32Array.BYTES_PER_ELEMENT,
					);

					(self as any).postMessage({
						type: "READY",
						positionsStride: POSITION_STRIDE,
						nodeCount,
					} as WorkerOutgoingMessage);
				}
				break;
			}

			// ----------------------------------------------------------------
			case "SET_PARAMS": {
				physicsWasm?.set_params(msg.params);
				break;
			}

			// ----------------------------------------------------------------
			case "SET_POSITIONS": {
				physicsWasm?.set_positions(msg.positions);
				break;
			}

			// ----------------------------------------------------------------
			// Main thread returned the ArrayBuffer for ping-pong reuse.
			case "RETURN_BUFFER": {
				pingPongBuffer = msg.buffer;
				break;
			}

			// ----------------------------------------------------------------
			case "STEP": {
				if (!physicsWasm || !wasmInstance) return;

				const startTime = performance.now();
				const ticks = msg.count || 1;

				// Run physics steps — step_n() batches multiple ticks in a
				// single WASM call to reduce JS↔WASM call overhead.
				if (ticks > 1) {
					physicsWasm.step_n(ticks);
				} else {
					physicsWasm.step();
				}

				const frameTimeMs = performance.now() - startTime;

				// Resolve WASM linear memory → Float32Array view (no copy).
				const memBuffer: ArrayBuffer = wasmInstance.memory
					? wasmInstance.memory.buffer
					: wasmInstance.exports.memory.buffer;

				const ptr: number = physicsWasm.positions_ptr();
				const len: number = physicsWasm.positions_len(); // nodeCount * 4

				const wasmView = new Float32Array(memBuffer, ptr, len);

				// ---- SAB fast path ----
				if (sharedView !== null) {
					// Single memcpy from WASM linear memory into shared memory.
					// The main thread reads sharedView directly — no transfer needed.
					sharedView.set(wasmView);

					(self as any).postMessage({
						type: "TICK",
						frameTimeMs,
						usedShared: true,
					} as WorkerOutgoingMessage);

					break;
				}

				// ---- Ping-pong fallback ----
				// Reuse the pre-allocated buffer returned by the main thread,
				// or fall back to a fresh allocation if the first tick hasn't
				// completed its round-trip yet.
				let outBuf: ArrayBuffer;
				if (pingPongBuffer !== null) {
					outBuf = pingPongBuffer;
					pingPongBuffer = null; // taken; will be returned by main thread
				} else {
					// Safety net: should rarely happen after the first tick.
					outBuf = new ArrayBuffer(len * Float32Array.BYTES_PER_ELEMENT);
				}

				const outView = new Float32Array(outBuf);
				outView.set(wasmView); // memcpy — fastest path for typed arrays

				(self as any).postMessage(
					{
						type: "TICK",
						positions: outView,
						frameTimeMs,
						usedShared: false,
					} as WorkerOutgoingMessage,
					[outBuf], // Transfer ownership — zero-copy hand-off to main thread
				);
				break;
			}
		}
	} catch (err: any) {
		(self as any).postMessage({
			type: "ERROR",
			error: err?.message || String(err),
		} as WorkerOutgoingMessage);
	}
};
