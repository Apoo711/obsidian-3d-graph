import { WorkerIncomingMessage, WorkerOutgoingMessage } from "./physics-types";

declare const require: any;

let wasmInstance: any = null;
let physicsWasm: any = null;
let nodeCount = 0;

self.onmessage = async (event: MessageEvent<WorkerIncomingMessage>) => {
	const msg = event.data;

	try {
		switch (msg.type) {
			case "INIT": {
				nodeCount = msg.nodeCount;
				
				// Initialize compiled WASM module via wasm-bindgen glue
				const initWasm = require("../../crates/graph-physics/pkg/graph_physics.js");
				
				// initSync builds WebAssembly.Module & Instance with exact imports
				wasmInstance = initWasm.initSync({ module: msg.wasmBytes });

				physicsWasm = new initWasm.GraphPhysicsWasm(msg.nodeCount, msg.edgesFlat, msg.params || {});

				if (msg.initialPositions) {
					physicsWasm.set_positions(msg.initialPositions);
				}

				(self as any).postMessage({ type: "READY" } as WorkerOutgoingMessage);
				break;
			}

			case "SET_PARAMS": {
				if (physicsWasm) {
					physicsWasm.set_params(msg.params);
				}
				break;
			}

			case "SET_POSITIONS": {
				if (physicsWasm) {
					physicsWasm.set_positions(msg.positions);
				}
				break;
			}

			case "STEP": {
				if (!physicsWasm || !wasmInstance) return;

				const startTime = performance.now();
				const ticks = msg.count || 1;

				for (let t = 0; t < ticks; t++) {
					physicsWasm.step();
				}

				const endTime = performance.now();

				// Access raw linear WASM memory positions buffer
				const ptr = physicsWasm.positions_ptr();
				const len = physicsWasm.positions_len();
				const memBuffer = wasmInstance.memory ? wasmInstance.memory.buffer : wasmInstance.exports.memory.buffer;
				
				// Slice position array to create transferable ArrayBuffer
				const positionsView = new Float32Array(memBuffer, ptr, len);
				const outputBuffer = new Float32Array(positionsView);

				// Transfer buffer ownership to main UI thread (0ms overhead)
				const tickMsg: WorkerOutgoingMessage = {
					type: "TICK",
					positions: outputBuffer,
					frameTimeMs: endTime - startTime,
				};

				(self as any).postMessage(tickMsg, [outputBuffer.buffer]);
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
