import {
  DEFAULT_SIMULATION_PARAMS,
  type SimulationParams,
  type WorkerIncomingMessage,
  type WorkerOutgoingMessage,
} from "./physics-types";
import { createWorkerBlobUrl } from "./wasm-loader";

/**
 * Called on every physics tick with the current position buffer.
 *
 * `positions` is a Float32Array backed by either:
 *   - A SharedArrayBuffer (SAB fast path) — the same memory on every call.
 *   - A transferred ArrayBuffer (ping-pong fallback) — a different buffer
 *     each call; the bridge immediately returns it to the worker for reuse.
 *
 * Position layout: stride 4 (Vec3A).
 *   x = positions[i * 4]
 *   y = positions[i * 4 + 1]
 *   z = positions[i * 4 + 2]
 */
export type TickCallback = (positions: Float32Array, frameTimeMs: number) => void;

export class PhysicsBridge {
  private worker: Worker | null = null;
  private onTickCallbacks: Set<TickCallback> = new Set();
  private isRunning = false;
  private isReady = false;

  private sharedPositions: Float32Array | null = null;
  private pingPongView: Float32Array | null = null;

  public positionsStride: 4 = 4;
  public nodeCount = 0;

  constructor() {}

  public async init(
    wasmBytes: ArrayBuffer,
    _workerScriptBlobUrl: string,
    nodeCount: number,
    edgesFlat: Uint32Array,
    params: Partial<SimulationParams> = DEFAULT_SIMULATION_PARAMS,
    initialPositions?: Float32Array,
  ): Promise<void> {
    this.dispose();

    const blobUrl = createWorkerBlobUrl();
    this.worker = new Worker(blobUrl);

    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error("Failed to create worker"));

      this.worker.onmessage = (event: MessageEvent<WorkerOutgoingMessage>) => {
        const msg = event.data;

        if (msg.type === "READY") {
          this.positionsStride = msg.positionsStride;
          this.nodeCount = msg.nodeCount;

          if (msg.sharedBuffer) {
            this.sharedPositions = new Float32Array(msg.sharedBuffer);
          }

          this.isReady = true;
          resolve();
        } else if (msg.type === "TICK") {
          let positions: Float32Array;

          if (msg.usedShared && this.sharedPositions) {
            positions = this.sharedPositions;
          } else if (msg.positions) {
            this.pingPongView = msg.positions;
            positions = msg.positions;

            Promise.resolve().then(() => {
              if (this.worker && msg.positions) {
                this.worker.postMessage(
                  {
                    type: "RETURN_BUFFER",
                    buffer: msg.positions.buffer,
                  } as WorkerIncomingMessage,
                  [msg.positions.buffer],
                );
              }
            });
          } else {
            return;
          }

          for (const cb of this.onTickCallbacks) {
            cb(positions, msg.frameTimeMs);
          }

          if (this.isRunning) {
            this.step();
          }
        } else if (msg.type === "ERROR") {
          console.error("[Rust WASM Physics Error]:", msg.error);
          reject(new Error(msg.error));
        }
      };

      this.worker.onerror = (err) => {
        console.error("[Physics Worker Error]:", err);
        reject(err);
      };

      const fullParams = { ...DEFAULT_SIMULATION_PARAMS, ...params };

      const initMsg: WorkerIncomingMessage = {
        type: "INIT",
        wasmBytes,
        nodeCount,
        edgesFlat,
        params: fullParams,
        initialPositions,
      };

      this.worker.postMessage(initMsg, [wasmBytes]);
    });
  }

  public start(): void {
    if (!this.isReady || this.isRunning) return;
    this.isRunning = true;
    this.step();
  }

  public stop(): void {
    this.isRunning = false;
  }

  public step(count = 1): void {
    if (!this.worker || !this.isReady) return;
    const msg: WorkerIncomingMessage = { type: "STEP", count };
    this.worker.postMessage(msg);
  }

  public setParams(params: Partial<SimulationParams>): void {
    if (!this.worker || !this.isReady) return;
    const fullParams = { ...DEFAULT_SIMULATION_PARAMS, ...params };
    const msg: WorkerIncomingMessage = {
      type: "SET_PARAMS",
      params: fullParams,
    };
    this.worker.postMessage(msg);
  }

  public setPositions(positions: Float32Array): void {
    if (!this.worker || !this.isReady) return;
    const msg: WorkerIncomingMessage = { type: "SET_POSITIONS", positions };
    this.worker.postMessage(msg);
  }

  public onTick(cb: TickCallback): () => void {
    this.onTickCallbacks.add(cb);
    return () => {
      this.onTickCallbacks.delete(cb);
    };
  }

  public dispose(): void {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.onTickCallbacks.clear();
    this.sharedPositions = null;
    this.pingPongView = null;
    this.isReady = false;
  }
}
