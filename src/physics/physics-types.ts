// ---------------------------------------------------------------------------
// SimulationParams — mirrors physics.rs SimulationParams
// ---------------------------------------------------------------------------

export interface SimulationParams {
	repulsion: number;
	attraction: number;
	link_distance: number;
	gravity: number;
	damping: number;
	max_velocity: number;
	dt: number;
	theta: number;
	alpha_min?: number;
}

export const DEFAULT_SIMULATION_PARAMS: SimulationParams = {
	repulsion: 400.0,
	attraction: 0.02,
	link_distance: 30.0,
	gravity: 0.05,
	damping: 0.85,
	max_velocity: 40.0,
	dt: 0.3,
	theta: 0.8,
	alpha_min: 0.001,
};

// ---------------------------------------------------------------------------
// Main-thread → Worker messages
// ---------------------------------------------------------------------------

export type WorkerIncomingMessage =
	| {
			type: "INIT";
			wasmBytes: ArrayBuffer;
			nodeCount: number;
			edgesFlat: Uint32Array;
			params?: Partial<SimulationParams>;
			initialPositions?: Float32Array;
	  }
	| { type: "STEP"; count?: number }
	| { type: "SET_PARAMS"; params: Partial<SimulationParams> }
	| { type: "SET_POSITIONS"; positions: Float32Array }
	/**
	 * Ping-pong fallback: main thread returns the ArrayBuffer it received so the
	 * worker can reuse it for the next tick — zero per-tick allocation.
	 */
	| { type: "RETURN_BUFFER"; buffer: ArrayBuffer };

// ---------------------------------------------------------------------------
// Worker → Main-thread messages
// ---------------------------------------------------------------------------

export type WorkerOutgoingMessage =
	| {
			type: "READY";
			/**
			 * Shared memory buffer (SAB fast path).  When present the worker writes
			 * positions into this buffer on every tick; the main thread reads from
			 * the same memory with no copy or transfer.
			 * Absent when SharedArrayBuffer is not available (no crossOriginIsolated).
			 */
			sharedBuffer?: SharedArrayBuffer;
			/**
			 * f32 stride between consecutive node positions.
			 * Always 4 (Vec3A layout: x, y, z, _pad).
			 */
			positionsStride: 4;
			nodeCount: number;
	  }
	| {
			type: "TICK";
			/**
			 * Transferred positions buffer (non-SAB fallback only).
			 * Undefined when usedShared = true.
			 */
			positions?: Float32Array;
			frameTimeMs: number;
			/** True when positions were written into the SharedArrayBuffer. */
			usedShared: boolean;
	  }
	| { type: "ERROR"; error: string };
