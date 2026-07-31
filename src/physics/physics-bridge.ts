import { SimulationParams, DEFAULT_SIMULATION_PARAMS, WorkerIncomingMessage, WorkerOutgoingMessage } from "./physics-types";

export type TickCallback = (positions: Float32Array, frameTimeMs: number) => void;

export class PhysicsBridge {
	private worker: Worker | null = null;
	private onTickCallbacks: Set<TickCallback> = new Set();
	private isRunning = false;
	private isReady = false;

	constructor() {}

	public async init(
		wasmBytes: ArrayBuffer,
		workerScriptBlobUrl: string,
		nodeCount: number,
		edgesFlat: Uint32Array,
		params: Partial<SimulationParams> = DEFAULT_SIMULATION_PARAMS,
		initialPositions?: Float32Array
	): Promise<void> {
		this.dispose();

		this.worker = new Worker(workerScriptBlobUrl);

		return new Promise((resolve, reject) => {
			if (!this.worker) return reject(new Error("Failed to create worker"));

			this.worker.onmessage = (event: MessageEvent<WorkerOutgoingMessage>) => {
				const msg = event.data;

				if (msg.type === "READY") {
					this.isReady = true;
					resolve();
				} else if (msg.type === "TICK") {
					for (const cb of this.onTickCallbacks) {
						cb(msg.positions, msg.frameTimeMs);
					}
					// Request next tick if active
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

			this.worker.postMessage(initMsg);
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
		const msg: WorkerIncomingMessage = { type: "SET_PARAMS", params: fullParams };
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
		this.isReady = false;
	}
}
