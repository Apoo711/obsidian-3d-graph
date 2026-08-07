import * as THREE from "three";

export interface NodeData {
  id: string;
  name: string;
  val?: number;
  color?: string;
}

export interface EdgeData {
  source: number;
  target: number;
  color?: string;
}

const NODE_VERT = /* glsl */ `
  attribute vec3 instanceTranslation;
  attribute vec3 instanceColor;
  attribute float instanceScale;

  varying vec3 vColor;
  varying vec3 vNormal;

  void main() {
    vColor  = instanceColor;
    vNormal = normalize(normalMatrix * normal);
    vec3 worldPos = position * instanceScale + instanceTranslation;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  }
`;

const NODE_FRAG = /* glsl */ `
  precision mediump float;

  varying vec3 vColor;
  varying vec3 vNormal;

  void main() {
    vec3  L    = normalize(vec3(1.0, 1.5, 1.0));
    float diff = dot(vNormal, L) * 0.4 + 0.6;
    gl_FragColor = vec4(vColor * diff, 0.9);
  }
`;

export class InstancedGraphRenderer {
  public scene: THREE.Scene;

  public instancedMesh: THREE.Mesh | null = null;
  public lineSegments: THREE.LineSegments | null = null;

  private translationAttr: THREE.InstancedBufferAttribute | null = null;
  private colorAttr: THREE.InstancedBufferAttribute | null = null;
  private scaleAttr: THREE.InstancedBufferAttribute | null = null;

  private instancedGeo: THREE.InstancedBufferGeometry | null = null;
  private nodeCount = 0;
  private edges: EdgeData[] = [];

  private edgeIndexBuffer: Int32Array = new Int32Array(0);
  private linePositions: Float32Array = new Float32Array(0);

  public positionsStride: 4 | 3 = 4;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  public initGraph(nodes: NodeData[], edges: EdgeData[], defaultNodeRadius = 3): void {
    this.clear();

    this.nodeCount = nodes.length;
    this.edges = edges;

    if (this.nodeCount === 0) return;

    const translationData = new Float32Array(this.nodeCount * 3);
    const colorData = new Float32Array(this.nodeCount * 3);
    const scaleData = new Float32Array(this.nodeCount);

    for (let i = 0; i < this.nodeCount; i++) {
      const hexColor = nodes[i].color ?? "#4f46e5";
      const [r, g, b] = hexToRgb01(hexColor);
      colorData[i * 3] = r;
      colorData[i * 3 + 1] = g;
      colorData[i * 3 + 2] = b;
      scaleData[i] = nodes[i].val ?? defaultNodeRadius;
    }

    const baseGeo = new THREE.SphereGeometry(1, 8, 6);
    this.instancedGeo = new THREE.InstancedBufferGeometry();
    this.instancedGeo.index = baseGeo.index;
    this.instancedGeo.setAttribute("position", baseGeo.getAttribute("position"));
    this.instancedGeo.setAttribute("normal", baseGeo.getAttribute("normal"));
    this.instancedGeo.instanceCount = this.nodeCount;
    baseGeo.dispose();

    this.translationAttr = new THREE.InstancedBufferAttribute(translationData, 3, false);
    this.translationAttr.setUsage(THREE.DynamicDrawUsage);

    this.colorAttr = new THREE.InstancedBufferAttribute(colorData, 3, false);
    this.colorAttr.setUsage(THREE.StaticDrawUsage);

    this.scaleAttr = new THREE.InstancedBufferAttribute(scaleData, 1, false);
    this.scaleAttr.setUsage(THREE.StaticDrawUsage);

    this.instancedGeo.setAttribute("instanceTranslation", this.translationAttr);
    this.instancedGeo.setAttribute("instanceColor", this.colorAttr);
    this.instancedGeo.setAttribute("instanceScale", this.scaleAttr);

    const nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      transparent: true,
      side: THREE.FrontSide,
    });

    this.instancedMesh = new THREE.Mesh(this.instancedGeo, nodeMaterial);
    this.instancedMesh.frustumCulled = false;
    this.scene.add(this.instancedMesh);

    const edgeCount = edges.length;
    if (edgeCount > 0) {
      this.edgeIndexBuffer = new Int32Array(edgeCount * 2);
      for (let e = 0; e < edgeCount; e++) {
        this.edgeIndexBuffer[e * 2] = edges[e].source;
        this.edgeIndexBuffer[e * 2 + 1] = edges[e].target;
      }

      this.linePositions = new Float32Array(edgeCount * 6);
      const lineGeo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(this.linePositions, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      lineGeo.setAttribute("position", posAttr);

      const lineMat = new THREE.LineBasicMaterial({
        color: 0x888888,
        transparent: true,
        opacity: 0.6,
      });

      this.lineSegments = new THREE.LineSegments(lineGeo, lineMat);
      this.scene.add(this.lineSegments);
    }
  }

  public updatePositions(positions: Float32Array): void {
    if (!this.translationAttr || this.nodeCount === 0) return;

    const trans = this.translationAttr.array as Float32Array;
    const stride = this.positionsStride;

    for (let i = 0, src = 0, dst = 0; i < this.nodeCount; i++, src += stride, dst += 3) {
      trans[dst] = positions[src];
      trans[dst + 1] = positions[src + 1];
      trans[dst + 2] = positions[src + 2];
    }
    this.translationAttr.needsUpdate = true;

    if (this.lineSegments && this.edgeIndexBuffer.length > 0) {
      const lp = this.linePositions;
      const ib = this.edgeIndexBuffer;
      const edgeCount = ib.length >> 1;

      for (let e = 0, lBase = 0; e < edgeCount; e++, lBase += 6) {
        const srcBase = ib[e * 2] * stride;
        const tgtBase = ib[e * 2 + 1] * stride;
        lp[lBase] = positions[srcBase];
        lp[lBase + 1] = positions[srcBase + 1];
        lp[lBase + 2] = positions[srcBase + 2];
        lp[lBase + 3] = positions[tgtBase];
        lp[lBase + 4] = positions[tgtBase + 1];
        lp[lBase + 5] = positions[tgtBase + 2];
      }

      (this.lineSegments.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  public updateNodeColor(nodeIndex: number, hexColor: string): void {
    if (!this.colorAttr) return;
    const [r, g, b] = hexToRgb01(hexColor);
    const arr = this.colorAttr.array as Float32Array;
    arr[nodeIndex * 3] = r;
    arr[nodeIndex * 3 + 1] = g;
    arr[nodeIndex * 3 + 2] = b;
    this.colorAttr.needsUpdate = true;
  }

  public updateNodeColors(colorMap: Map<number, string>): void {
    if (!this.colorAttr || colorMap.size === 0) return;
    const arr = this.colorAttr.array as Float32Array;
    for (const [nodeIndex, hexColor] of colorMap) {
      const [r, g, b] = hexToRgb01(hexColor);
      arr[nodeIndex * 3] = r;
      arr[nodeIndex * 3 + 1] = g;
      arr[nodeIndex * 3 + 2] = b;
    }
    this.colorAttr.needsUpdate = true;
  }

  public getNodeIndexAtRay(raycaster: THREE.Raycaster): number | null {
    if (!this.translationAttr || this.nodeCount === 0) return null;

    const ray = raycaster.ray;
    const trans = this.translationAttr.array as Float32Array;
    const scale = this.scaleAttr?.array as Float32Array | undefined;
    let closestDist = Infinity;
    let closestIdx: number | null = null;

    for (let i = 0, base = 0; i < this.nodeCount; i++, base += 3) {
      const sx = trans[base];
      const sy = trans[base + 1];
      const sz = trans[base + 2];
      const radius = (scale?.[i] ?? 3) * 1.5;

      const dx = sx - ray.origin.x;
      const dy = sy - ray.origin.y;
      const dz = sz - ray.origin.z;
      const dot = dx * ray.direction.x + dy * ray.direction.y + dz * ray.direction.z;
      if (dot < 0) continue;
      const distSq = dx * dx + dy * dy + dz * dz - dot * dot;
      if (distSq <= radius * radius && dot < closestDist) {
        closestDist = dot;
        closestIdx = i;
      }
    }

    return closestIdx;
  }

  public clear(): void {
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedGeo?.dispose();
      (this.instancedMesh.material as THREE.ShaderMaterial).dispose();
      this.instancedMesh = null;
      this.instancedGeo = null;
      this.translationAttr = null;
      this.colorAttr = null;
      this.scaleAttr = null;
    }
    if (this.lineSegments) {
      this.scene.remove(this.lineSegments);
      this.lineSegments.geometry.dispose();
      (this.lineSegments.material as THREE.Material).dispose();
      this.lineSegments = null;
    }
    this.nodeCount = 0;
    this.edges = [];
    this.edgeIndexBuffer = new Int32Array(0);
    this.linePositions = new Float32Array(0);
  }
}

function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}
