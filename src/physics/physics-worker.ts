import type { WorkerIncomingMessage, WorkerOutgoingMessage } from "./physics-types";

declare const require: any;

let wasmInstance: any = null;
let physicsWasm: any = null;
let nodeCount = 0;

const POSITION_STRIDE = 4 as const;

let sharedView: Float32Array | null = null;

let pingPongBuffer: ArrayBuffer | null = null;

self.onmessage = async (event: MessageEvent<WorkerIncomingMessage>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "INIT": {
        nodeCount = msg.nodeCount;
        const floatCount = nodeCount * POSITION_STRIDE;
        const initWasm = require("../../crates/graph-physics/pkg/graph_physics.js");
        wasmInstance = initWasm.initSync({ module: msg.wasmBytes });
        physicsWasm = new initWasm.GraphPhysicsWasm(msg.nodeCount, msg.edgesFlat, msg.params || {});

        if (msg.initialPositions) {
          physicsWasm.set_positions(msg.initialPositions);
        }

        if (typeof SharedArrayBuffer !== "undefined") {
          const sab = new SharedArrayBuffer(floatCount * Float32Array.BYTES_PER_ELEMENT);
          sharedView = new Float32Array(sab);

          (self as any).postMessage({
            type: "READY",
            sharedBuffer: sab,
            positionsStride: POSITION_STRIDE,
            nodeCount,
          } as WorkerOutgoingMessage);
        } else {
          pingPongBuffer = new ArrayBuffer(floatCount * Float32Array.BYTES_PER_ELEMENT);

          (self as any).postMessage({
            type: "READY",
            positionsStride: POSITION_STRIDE,
            nodeCount,
          } as WorkerOutgoingMessage);
        }
        break;
      }

      case "SET_PARAMS": {
        physicsWasm?.set_params(msg.params);
        break;
      }

      case "SET_POSITIONS": {
        physicsWasm?.set_positions(msg.positions);
        break;
      }

      case "RETURN_BUFFER": {
        pingPongBuffer = msg.buffer;
        break;
      }

      case "STEP": {
        if (!physicsWasm || !wasmInstance) return;

        const startTime = performance.now();
        const ticks = msg.count || 1;

        if (ticks > 1) {
          physicsWasm.step_n(ticks);
        } else {
          physicsWasm.step();
        }

        const frameTimeMs = performance.now() - startTime;

        const memBuffer: ArrayBuffer = wasmInstance.memory
          ? wasmInstance.memory.buffer
          : wasmInstance.exports.memory.buffer;

        const ptr: number = physicsWasm.positions_ptr();
        const len: number = physicsWasm.positions_len();

        const wasmView = new Float32Array(memBuffer, ptr, len);

        if (sharedView !== null) {
          sharedView.set(wasmView);

          (self as any).postMessage({
            type: "TICK",
            frameTimeMs,
            usedShared: true,
          } as WorkerOutgoingMessage);

          break;
        }

        let outBuf: ArrayBuffer;
        if (pingPongBuffer !== null) {
          outBuf = pingPongBuffer;
          pingPongBuffer = null;
        } else {
          outBuf = new ArrayBuffer(len * Float32Array.BYTES_PER_ELEMENT);
        }

        const outView = new Float32Array(outBuf);
        outView.set(wasmView);

        (self as any).postMessage(
          {
            type: "TICK",
            positions: outView,
            frameTimeMs,
            usedShared: false,
          } as WorkerOutgoingMessage,
          [outBuf],
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
