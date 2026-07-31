import * as THREE from "three";

export interface NodeData {
	id: string;
	name: string;
	val?: number;
	color?: string;
}

export interface EdgeData {
	source: number; // Node index
	target: number; // Node index
	color?: string;
}

export class InstancedGraphRenderer {
	public scene: THREE.Scene;
	public instancedMesh: THREE.InstancedMesh | null = null;
	public lineSegments: THREE.LineSegments | null = null;

	private nodeCount = 0;
	private edges: EdgeData[] = [];
	private linePositions: Float32Array = new Float32Array(0);

	constructor(scene: THREE.Scene) {
		this.scene = scene;
	}

	public initGraph(nodes: NodeData[], edges: EdgeData[], defaultNodeRadius = 3): void {
		this.clear();

		this.nodeCount = nodes.length;
		this.edges = edges;

		if (this.nodeCount === 0) return;

		const sphereGeometry = new THREE.SphereGeometry(defaultNodeRadius, 16, 16);
		const nodeMaterial = new THREE.MeshStandardMaterial({
			roughness: 0.2,
			metalness: 0.1,
		});

		this.instancedMesh = new THREE.InstancedMesh(sphereGeometry, nodeMaterial, this.nodeCount);
		this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

		const matrixDummy = new THREE.Matrix4();
		const color = new THREE.Color();

		for (let i = 0; i < this.nodeCount; i++) {
			const hex = nodes[i].color || "#4f46e5";
			color.set(hex);
			this.instancedMesh.setColorAt(i, color);

			matrixDummy.identity();
			this.instancedMesh.setMatrixAt(i, matrixDummy);
		}

		if (this.instancedMesh.instanceColor) {
			this.instancedMesh.instanceColor.needsUpdate = true;
		}
		this.instancedMesh.instanceMatrix.needsUpdate = true;
		this.scene.add(this.instancedMesh);

		const edgeCount = edges.length;
		if (edgeCount > 0) {
			this.linePositions = new Float32Array(edgeCount * 2 * 3);
			const lineGeometry = new THREE.BufferGeometry();
			
			const posAttr = new THREE.BufferAttribute(this.linePositions, 3);
			posAttr.setUsage(THREE.DynamicDrawUsage);
			lineGeometry.setAttribute("position", posAttr);

			const lineMaterial = new THREE.LineBasicMaterial({
				color: 0x888888,
				transparent: true,
				opacity: 0.6,
				linewidth: 1,
			});

			this.lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial);
			this.scene.add(this.lineSegments);
		}
	}

	public updatePositions(positions: Float32Array): void {
		if (!this.instancedMesh || this.nodeCount === 0) return;

		const instanceArray = this.instancedMesh.instanceMatrix.array as Float32Array;

		for (let i = 0; i < this.nodeCount; i++) {
			const matrixIdx = i * 16;
			const posIdx = i * 3;

			instanceArray[matrixIdx + 12] = positions[posIdx];
			instanceArray[matrixIdx + 13] = positions[posIdx + 1];
			instanceArray[matrixIdx + 14] = positions[posIdx + 2];
		}
		this.instancedMesh.instanceMatrix.needsUpdate = true;

		if (this.lineSegments && this.edges.length > 0) {
			const edgeCount = this.edges.length;
			for (let e = 0; e < edgeCount; e++) {
				const src = this.edges[e].source;
				const tgt = this.edges[e].target;

				const srcIdx = src * 3;
				const tgtIdx = tgt * 3;

				const lineIdx = e * 6;
				this.linePositions[lineIdx] = positions[srcIdx];
				this.linePositions[lineIdx + 1] = positions[srcIdx + 1];
				this.linePositions[lineIdx + 2] = positions[srcIdx + 2];

				this.linePositions[lineIdx + 3] = positions[tgtIdx];
				this.linePositions[lineIdx + 4] = positions[tgtIdx + 1];
				this.linePositions[lineIdx + 5] = positions[tgtIdx + 2];
			}

			const posAttr = this.lineSegments.geometry.attributes.position as THREE.BufferAttribute;
			posAttr.needsUpdate = true;
		}
	}

	public getNodeIndexAtRay(raycaster: THREE.Raycaster): number | null {
		if (!this.instancedMesh) return null;
		const intersects = raycaster.intersectObject(this.instancedMesh);
		if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
			return intersects[0].instanceId;
		}
		return null;
	}

	public clear(): void {
		if (this.instancedMesh) {
			this.scene.remove(this.instancedMesh);
			this.instancedMesh.geometry.dispose();
			if (Array.isArray(this.instancedMesh.material)) {
				this.instancedMesh.material.forEach((m) => m.dispose());
			} else {
				this.instancedMesh.material.dispose();
			}
			this.instancedMesh = null;
		}

		if (this.lineSegments) {
			this.scene.remove(this.lineSegments);
			this.lineSegments.geometry.dispose();
			if (Array.isArray(this.lineSegments.material)) {
				this.lineSegments.material.forEach((m) => m.dispose());
			} else {
				this.lineSegments.material.dispose();
			}
			this.lineSegments = null;
		}

		this.nodeCount = 0;
		this.edges = [];
	}
}
