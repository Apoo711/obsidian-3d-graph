import * as THREE from "three";
import { NodeShape } from "../types";

export interface NodeData {
  id: string;
  name: string;
  shape?: NodeShape;
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
    vec3  L    = normalize(vec3(0.5, 1.2, 0.8));
    float diff = max(dot(vNormal, L), 0.0) * 0.4 + 0.6;
    gl_FragColor = vec4(vColor * diff, 0.95);
  }
`;

const LINE_VERT = /* glsl */ `
  attribute vec3 color;
  varying vec3 vColor;

  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LINE_FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  uniform float uOpacity;

  void main() {
    gl_FragColor = vec4(vColor, uOpacity);
  }
`;

interface ShapeBucket {
  shape: NodeShape;
  indices: number[]; // global node indices
  mesh: THREE.Mesh | null;
  geometry: THREE.InstancedBufferGeometry | null;
  translationAttr: THREE.InstancedBufferAttribute | null;
  colorAttr: THREE.InstancedBufferAttribute | null;
  scaleAttr: THREE.InstancedBufferAttribute | null;
}

export class InstancedGraphRenderer {
  public scene: THREE.Scene;

  public shapeBuckets = new Map<NodeShape, ShapeBucket>();
  public lineSegments: THREE.LineSegments | null = null;
  private lineMat: THREE.ShaderMaterial | null = null;
  private linePositionsAttr: THREE.BufferAttribute | null = null;
  private lineColorsAttr: THREE.BufferAttribute | null = null;

  private nodeCount = 0;
  private nodeScales: Float32Array = new Float32Array(0);
  private nodeBucketMap: { shape: NodeShape; localIndex: number }[] = [];
  private edges: EdgeData[] = [];

  private edgeIndexBuffer: Int32Array = new Int32Array(0);
  private linePositions: Float32Array = new Float32Array(0);
  private lineColors: Float32Array = new Float32Array(0);

  public positionsStride: 4 | 3 = 4;
  private defaultLinkColor: [number, number, number] = [0.4, 0.4, 0.4];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  public initGraph(
    nodes: NodeData[],
    edges: EdgeData[],
    defaultNodeRadius = 3,
    defaultLinkHex = "#666666",
    linkOpacity = 0.6,
  ): void {
    this.clear();

    this.nodeCount = nodes.length;
    this.edges = edges;
    this.defaultLinkColor = hexToRgb01(defaultLinkHex);

    if (this.nodeCount === 0) return;

    this.nodeScales = new Float32Array(this.nodeCount);
    this.nodeBucketMap = new Array(this.nodeCount);

    // Group nodes by shape
    const groups = new Map<NodeShape, number[]>();
    for (let i = 0; i < this.nodeCount; i++) {
      const shape = nodes[i].shape || NodeShape.Sphere;
      let groupList = groups.get(shape);
      if (!groupList) {
        groupList = [];
        groups.set(shape, groupList);
      }
      groupList.push(i);
      this.nodeScales[i] = (nodes[i].val ?? defaultNodeRadius) * 1.5;
    }

    const sharedMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      transparent: true,
      side: THREE.FrontSide,
    });

    for (const [shape, indices] of groups.entries()) {
      const count = indices.length;
      const translationData = new Float32Array(count * 3);
      const colorData = new Float32Array(count * 3);
      const scaleData = new Float32Array(count);

      for (let localIdx = 0; localIdx < count; localIdx++) {
        const globalIdx = indices[localIdx];
        this.nodeBucketMap[globalIdx] = { shape, localIndex: localIdx };

        const hexColor = nodes[globalIdx].color ?? "#4f46e5";
        const [r, g, b] = hexToRgb01(hexColor);
        colorData[localIdx * 3] = r;
        colorData[localIdx * 3 + 1] = g;
        colorData[localIdx * 3 + 2] = b;
        scaleData[localIdx] = this.nodeScales[globalIdx];
      }

      const baseGeo = this.createBaseGeometry(shape);
      const instancedGeo = new THREE.InstancedBufferGeometry();
      instancedGeo.index = baseGeo.index;
      instancedGeo.setAttribute("position", baseGeo.getAttribute("position"));
      instancedGeo.setAttribute("normal", baseGeo.getAttribute("normal"));
      instancedGeo.instanceCount = count;
      baseGeo.dispose();

      const translationAttr = new THREE.InstancedBufferAttribute(translationData, 3, false);
      translationAttr.setUsage(THREE.DynamicDrawUsage);

      const colorAttr = new THREE.InstancedBufferAttribute(colorData, 3, false);
      colorAttr.setUsage(THREE.DynamicDrawUsage);

      const scaleAttr = new THREE.InstancedBufferAttribute(scaleData, 1, false);
      scaleAttr.setUsage(THREE.StaticDrawUsage);

      instancedGeo.setAttribute("instanceTranslation", translationAttr);
      instancedGeo.setAttribute("instanceColor", colorAttr);
      instancedGeo.setAttribute("instanceScale", scaleAttr);

      const mesh = new THREE.Mesh(instancedGeo, sharedMat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);

      this.shapeBuckets.set(shape, {
        shape,
        indices,
        mesh,
        geometry: instancedGeo,
        translationAttr,
        colorAttr,
        scaleAttr,
      });
    }

    // Initialize edge lines (Single LineSegments draw call)
    const edgeCount = edges.length;
    if (edgeCount > 0) {
      this.edgeIndexBuffer = new Int32Array(edgeCount * 2);
      this.linePositions = new Float32Array(edgeCount * 6);
      this.lineColors = new Float32Array(edgeCount * 6);

      for (let e = 0; e < edgeCount; e++) {
        this.edgeIndexBuffer[e * 2] = edges[e].source;
        this.edgeIndexBuffer[e * 2 + 1] = edges[e].target;

        const edgeColor = edges[e].color;
        const [r, g, b] = edgeColor ? hexToRgb01(edgeColor) : this.defaultLinkColor;
        const cBase = e * 6;
        this.lineColors[cBase] = r;
        this.lineColors[cBase + 1] = g;
        this.lineColors[cBase + 2] = b;
        this.lineColors[cBase + 3] = r;
        this.lineColors[cBase + 4] = g;
        this.lineColors[cBase + 5] = b;
      }

      const lineGeo = new THREE.BufferGeometry();
      this.linePositionsAttr = new THREE.BufferAttribute(this.linePositions, 3);
      this.linePositionsAttr.setUsage(THREE.DynamicDrawUsage);
      lineGeo.setAttribute("position", this.linePositionsAttr);

      this.lineColorsAttr = new THREE.BufferAttribute(this.lineColors, 3);
      this.lineColorsAttr.setUsage(THREE.DynamicDrawUsage);
      lineGeo.setAttribute("color", this.lineColorsAttr);

      this.lineMat = new THREE.ShaderMaterial({
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        uniforms: {
          uOpacity: { value: linkOpacity },
        },
        transparent: true,
        depthWrite: false,
      });

      this.lineSegments = new THREE.LineSegments(lineGeo, this.lineMat);
      this.lineSegments.frustumCulled = false;
      this.scene.add(this.lineSegments);
    }
  }

  private createBaseGeometry(shape: NodeShape): THREE.BufferGeometry {
    switch (shape) {
      case NodeShape.Cube:
        return new THREE.BoxGeometry(1.4, 1.4, 1.4);
      case NodeShape.Pyramid:
        return new THREE.ConeGeometry(1.2, 1.6, 4);
      case NodeShape.Tetrahedron:
        return new THREE.TetrahedronGeometry(1.3);
      default:
        return new THREE.SphereGeometry(1, 10, 8);
    }
  }

  public updatePositions(positions: Float32Array): void {
    if (this.nodeCount === 0) return;

    const stride = this.positionsStride;

    // Update node positions per shape bucket directly
    for (const bucket of this.shapeBuckets.values()) {
      if (!bucket.translationAttr) continue;
      const trans = bucket.translationAttr.array as Float32Array;
      const indices = bucket.indices;
      const count = indices.length;

      for (let localIdx = 0; localIdx < count; localIdx++) {
        const globalIdx = indices[localIdx];
        const src = globalIdx * stride;
        const dst = localIdx * 3;
        trans[dst] = positions[src];
        trans[dst + 1] = positions[src + 1];
        trans[dst + 2] = positions[src + 2];
      }
      bucket.translationAttr.needsUpdate = true;
    }

    // Update line positions in single pass
    if (this.lineSegments && this.linePositionsAttr && this.edgeIndexBuffer.length > 0) {
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

      this.linePositionsAttr.needsUpdate = true;
    }
  }

  public updateNodeColor(nodeIndex: number, hexColor: string): void {
    const map = this.nodeBucketMap[nodeIndex];
    if (!map) return;
    const bucket = this.shapeBuckets.get(map.shape);
    if (!bucket?.colorAttr) return;

    const [r, g, b] = hexToRgb01(hexColor);
    const arr = bucket.colorAttr.array as Float32Array;
    const dst = map.localIndex * 3;
    arr[dst] = r;
    arr[dst + 1] = g;
    arr[dst + 2] = b;
    bucket.colorAttr.needsUpdate = true;
  }

  public updateNodeColors(colorMap: Map<number, string>): void {
    if (colorMap.size === 0) return;

    const dirtyBuckets = new Set<ShapeBucket>();

    for (const [nodeIndex, hexColor] of colorMap) {
      const map = this.nodeBucketMap[nodeIndex];
      if (!map) continue;
      const bucket = this.shapeBuckets.get(map.shape);
      if (!bucket?.colorAttr) continue;

      const [r, g, b] = hexToRgb01(hexColor);
      const arr = bucket.colorAttr.array as Float32Array;
      const dst = map.localIndex * 3;
      arr[dst] = r;
      arr[dst + 1] = g;
      arr[dst + 2] = b;
      dirtyBuckets.add(bucket);
    }

    for (const bucket of dirtyBuckets) {
      if (bucket.colorAttr) {
        bucket.colorAttr.needsUpdate = true;
      }
    }
  }

  public updateEdgeColors(
    highlightedEdges: Set<number>,
    highlightColorHex: string,
    defaultColorHex: string,
  ): void {
    if (!this.lineColorsAttr || this.edges.length === 0) return;

    const [hr, hg, hb] = hexToRgb01(highlightColorHex);
    const [dr, dg, db] = hexToRgb01(defaultColorHex);
    const lc = this.lineColors;
    const edgeCount = this.edges.length;

    for (let e = 0; e < edgeCount; e++) {
      const isHigh = highlightedEdges.has(e);
      const r = isHigh ? hr : dr;
      const g = isHigh ? hg : db;
      const b = isHigh ? hb : dg;
      const cBase = e * 6;
      lc[cBase] = r;
      lc[cBase + 1] = g;
      lc[cBase + 2] = b;
      lc[cBase + 3] = r;
      lc[cBase + 4] = g;
      lc[cBase + 5] = b;
    }

    this.lineColorsAttr.needsUpdate = true;
  }

  public getNodeIndexAtRay(raycaster: THREE.Raycaster, positions: Float32Array): number | null {
    if (this.nodeCount === 0) return null;

    const ray = raycaster.ray;
    const stride = this.positionsStride;
    let closestDist = Infinity;
    let closestIdx: number | null = null;

    for (let i = 0; i < this.nodeCount; i++) {
      const base = i * stride;
      const sx = positions[base];
      const sy = positions[base + 1];
      const sz = positions[base + 2];
      const radius = this.nodeScales[i] || 3.0;

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
    for (const bucket of this.shapeBuckets.values()) {
      if (bucket.mesh) {
        this.scene.remove(bucket.mesh);
        bucket.geometry?.dispose();
        if (bucket.mesh.material instanceof THREE.Material) {
          bucket.mesh.material.dispose();
        }
      }
    }
    this.shapeBuckets.clear();

    if (this.lineSegments) {
      this.scene.remove(this.lineSegments);
      this.lineSegments.geometry.dispose();
      this.lineMat?.dispose();
      this.lineSegments = null;
      this.lineMat = null;
      this.linePositionsAttr = null;
      this.lineColorsAttr = null;
    }

    this.nodeCount = 0;
    this.nodeScales = new Float32Array(0);
    this.nodeBucketMap = [];
    this.edges = [];
    this.edgeIndexBuffer = new Int32Array(0);
    this.linePositions = new Float32Array(0);
    this.lineColors = new Float32Array(0);
  }
}

const HEX_COLOR_CACHE = new Map<string, [number, number, number]>();

export function hexToRgb01(color: string): [number, number, number] {
  const cached = HEX_COLOR_CACHE.get(color);
  if (cached) return cached;

  let r = 0.5;
  let g = 0.5;
  let b = 0.5;

  if (color.startsWith("#")) {
    const cleanHex = color.substring(1);
    if (cleanHex.length === 3) {
      r = (parseInt(cleanHex[0] + cleanHex[0], 16) || 0) / 255;
      g = (parseInt(cleanHex[1] + cleanHex[1], 16) || 0) / 255;
      b = (parseInt(cleanHex[2] + cleanHex[2], 16) || 0) / 255;
    } else {
      const n = parseInt(cleanHex, 16) || 0;
      r = ((n >> 16) & 0xff) / 255;
      g = ((n >> 8) & 0xff) / 255;
      b = (n & 0xff) / 255;
    }
  } else if (color.startsWith("rgb")) {
    const match = color.match(/\d+(\.\d+)?/g);
    if (match && match.length >= 3) {
      r = Math.min(255, Math.max(0, parseFloat(match[0]))) / 255;
      g = Math.min(255, Math.max(0, parseFloat(match[1]))) / 255;
      b = Math.min(255, Math.max(0, parseFloat(match[2]))) / 255;
    }
  } else {
    const cleanHex = color.replace("#", "");
    const n = parseInt(cleanHex, 16) || 0;
    r = ((n >> 16) & 0xff) / 255;
    g = ((n >> 8) & 0xff) / 255;
    b = (n & 0xff) / 255;
  }

  const res: [number, number, number] = [r, g, b];
  HEX_COLOR_CACHE.set(color, res);
  return res;
}
