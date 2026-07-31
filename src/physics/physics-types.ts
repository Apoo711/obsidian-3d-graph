export interface SimulationParams {
	repulsion: number;
	attraction: number;
	link_distance: number;
	gravity: number;
	damping: number;
	max_velocity: number;
	dt: number;
	theta: number;
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
};

export type WorkerIncomingMessage =
	| { type: "INIT"; wasmBytes: ArrayBuffer; nodeCount: number; edgesFlat: Uint32Array; params?: Partial<SimulationParams>; initialPositions?: Float32Array }
	| { type: "STEP"; count?: number }
	| { type: "SET_PARAMS"; params: Partial<SimulationParams> }
	| { type: "SET_POSITIONS"; positions: Float32Array };

export type WorkerOutgoingMessage =
	| { type: "READY" }
	| { type: "TICK"; positions: Float32Array; frameTimeMs: number }
	| { type: "ERROR"; error: string };
