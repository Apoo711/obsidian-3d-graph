import * as THREE from "three";
import { type Graph3DPluginSettings, type GraphNode, NodeType } from "../types";

export interface LabelItem {
  id: string;
  name: string;
  type: NodeType;
  nodeIndex: number;
  size: number;
}

interface AtlasGlyph {
  u: number;
  v: number;
  w: number;
  h: number;
  pixelWidth: number;
  pixelHeight: number;
  aspect: number;
}

const LABEL_VERT = /* glsl */ `
  attribute vec3 instanceTranslation;
  attribute vec2 instanceScale;
  attribute vec4 instanceUV;
  attribute float instanceOpacity;

  varying vec2 vUv;
  varying float vOpacity;

  void main() {
    vOpacity = instanceOpacity;
    vUv = vec2(instanceUV.x + uv.x * instanceUV.z, instanceUV.y + (1.0 - uv.y) * instanceUV.w);

    // Billboarding in view space: quad faces the camera
    vec4 mvPosition = modelViewMatrix * vec4(instanceTranslation, 1.0);
    mvPosition.xy += position.xy * instanceScale;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const LABEL_FRAG = /* glsl */ `
  precision mediump float;

  uniform sampler2D uAtlas;

  varying vec2 vUv;
  varying float vOpacity;

  void main() {
    if (vOpacity < 0.005) {
      discard;
    }
    vec4 texColor = texture2D(uAtlas, vUv);
    if (texColor.a < 0.01) {
      discard;
    }
    gl_FragColor = vec4(texColor.rgb, texColor.a * vOpacity);
  }
`;

export class InstancedLabelRenderer {
  private scene: THREE.Scene;
  private atlasCanvas: HTMLCanvasElement;
  private atlasCtx: CanvasRenderingContext2D;
  private atlasTexture: THREE.CanvasTexture | null = null;
  private atlasWidth = 2048;
  private atlasHeight = 2048;

  private atlasCursorX = 0;
  private atlasCursorY = 0;
  private atlasRowHeight = 0;
  private labelCache = new Map<string, AtlasGlyph>();

  public instancedMesh: THREE.Mesh | null = null;
  private instancedGeo: THREE.InstancedBufferGeometry | null = null;
  private translationAttr: THREE.InstancedBufferAttribute | null = null;
  private scaleAttr: THREE.InstancedBufferAttribute | null = null;
  private uvAttr: THREE.InstancedBufferAttribute | null = null;
  private opacityAttr: THREE.InstancedBufferAttribute | null = null;
  private material: THREE.ShaderMaterial | null = null;

  private labels: LabelItem[] = [];
  private labelCount = 0;
  private positionsStride: 4 | 3 = 4;

  // Frustum & raycast occlusion reusable objects
  private projScreenMatrix = new THREE.Matrix4();
  private frustum = new THREE.Frustum();
  private tempNodePos = new THREE.Vector3();
  private tempCamToNode = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.atlasCanvas = document.createElement("canvas");
    this.atlasCanvas.width = this.atlasWidth;
    this.atlasCanvas.height = this.atlasHeight;
    const ctx = this.atlasCanvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("Failed to create 2D canvas context for label atlas");
    this.atlasCtx = ctx;
  }

  public initLabels(
    nodes: GraphNode[],
    settings: Graph3DPluginSettings,
    positionsStride: 4 | 3 = 4,
  ): void {
    this.clear();
    this.positionsStride = positionsStride;

    this.labels = nodes.map((node, idx) => {
      let size: number;
      switch (node.type) {
        case NodeType.Tag:
          size = settings.tagNodeSize;
          break;
        case NodeType.Attachment:
          size = settings.attachmentNodeSize;
          break;
        default:
          size = settings.nodeSize;
      }
      return {
        id: node.id,
        name: node.name || node.id,
        type: node.type,
        nodeIndex: idx,
        size: size * 1.5,
      };
    });

    this.labelCount = this.labels.length;
    if (this.labelCount === 0) return;

    this.buildAtlas(settings);
    this.setupInstancedMesh(settings);
  }

  private buildAtlas(settings: Graph3DPluginSettings): void {
    const isDarkMode = document.body.classList.contains("theme-dark");
    const textColor = isDarkMode ? settings.labelTextColorDark : settings.labelTextColorLight;
    const bgColor = this.hexToRgba(settings.labelBackgroundColor, settings.labelBackgroundOpacity);

    // Reset atlas canvas
    this.atlasCtx.clearRect(0, 0, this.atlasWidth, this.atlasHeight);
    this.atlasCursorX = 2;
    this.atlasCursorY = 2;
    this.atlasRowHeight = 0;
    this.labelCache.clear();

    const fontSize = 28; // High resolution font for atlas crispness
    this.atlasCtx.font = `600 ${fontSize}px sans-serif`;
    this.atlasCtx.textBaseline = "middle";

    const paddingX = 14;
    const paddingY = 8;
    const borderRadius = 8;

    for (let i = 0; i < this.labelCount; i++) {
      const text = this.labels[i].name;
      const cacheKey = `${text}_${textColor}_${bgColor}`;

      if (this.labelCache.has(cacheKey)) continue;

      const metrics = this.atlasCtx.measureText(text);
      const textWidth = Math.ceil(metrics.width);
      const boxWidth = textWidth + paddingX * 2;
      const boxHeight = fontSize + paddingY * 2;

      // Atlas row wrapping
      if (this.atlasCursorX + boxWidth + 2 > this.atlasWidth) {
        this.atlasCursorX = 2;
        this.atlasCursorY += this.atlasRowHeight + 2;
        this.atlasRowHeight = 0;
      }

      if (this.atlasCursorY + boxHeight + 2 > this.atlasHeight) {
        console.warn("[3D Graph] Label atlas full, some labels will share slots");
        break;
      }

      const x = this.atlasCursorX;
      const y = this.atlasCursorY;

      // Draw background rounded pill
      this.atlasCtx.fillStyle = bgColor;
      this.drawRoundedRect(this.atlasCtx, x, y, boxWidth, boxHeight, borderRadius);
      this.atlasCtx.fill();

      // Draw text
      this.atlasCtx.fillStyle = textColor;
      this.atlasCtx.fillText(text, x + paddingX, y + boxHeight / 2);

      // Save UV rect
      const u = x / this.atlasWidth;
      const v = y / this.atlasHeight;
      const w = boxWidth / this.atlasWidth;
      const h = boxHeight / this.atlasHeight;

      this.labelCache.set(cacheKey, {
        u,
        v,
        w,
        h,
        pixelWidth: boxWidth,
        pixelHeight: boxHeight,
        aspect: boxWidth / boxHeight,
      });

      this.atlasCursorX += boxWidth + 2;
      if (boxHeight > this.atlasRowHeight) {
        this.atlasRowHeight = boxHeight;
      }
    }

    if (this.atlasTexture) {
      this.atlasTexture.dispose();
    }
    this.atlasTexture = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlasTexture.minFilter = THREE.LinearFilter;
    this.atlasTexture.magFilter = THREE.LinearFilter;
    this.atlasTexture.generateMipmaps = false;
    this.atlasTexture.needsUpdate = true;
  }

  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private setupInstancedMesh(settings: Graph3DPluginSettings): void {
    if (this.labelCount === 0 || !this.atlasTexture) return;

    const quadGeo = new THREE.PlaneGeometry(1, 1);
    this.instancedGeo = new THREE.InstancedBufferGeometry();
    this.instancedGeo.index = quadGeo.index;
    this.instancedGeo.setAttribute("position", quadGeo.getAttribute("position"));
    this.instancedGeo.setAttribute("uv", quadGeo.getAttribute("uv"));
    this.instancedGeo.instanceCount = this.labelCount;
    quadGeo.dispose();

    const translationData = new Float32Array(this.labelCount * 3);
    const scaleData = new Float32Array(this.labelCount * 2);
    const uvData = new Float32Array(this.labelCount * 4);
    const opacityData = new Float32Array(this.labelCount);

    const isDarkMode = document.body.classList.contains("theme-dark");
    const textColor = isDarkMode ? settings.labelTextColorDark : settings.labelTextColorLight;
    const bgColor = this.hexToRgba(settings.labelBackgroundColor, settings.labelBackgroundOpacity);
    const baseHeight = settings.labelTextSize * 2.2;

    for (let i = 0; i < this.labelCount; i++) {
      const text = this.labels[i].name;
      const cacheKey = `${text}_${textColor}_${bgColor}`;
      const glyph = this.labelCache.get(cacheKey) || this.labelCache.values().next().value;

      if (glyph) {
        uvData[i * 4] = glyph.u;
        uvData[i * 4 + 1] = glyph.v;
        uvData[i * 4 + 2] = glyph.w;
        uvData[i * 4 + 3] = glyph.h;

        const h = baseHeight;
        const w = baseHeight * glyph.aspect;
        scaleData[i * 2] = w;
        scaleData[i * 2 + 1] = h;
      }
      opacityData[i] = 0.0;
    }

    this.translationAttr = new THREE.InstancedBufferAttribute(translationData, 3, false);
    this.translationAttr.setUsage(THREE.DynamicDrawUsage);

    this.scaleAttr = new THREE.InstancedBufferAttribute(scaleData, 2, false);
    this.scaleAttr.setUsage(THREE.StaticDrawUsage);

    this.uvAttr = new THREE.InstancedBufferAttribute(uvData, 4, false);
    this.uvAttr.setUsage(THREE.StaticDrawUsage);

    this.opacityAttr = new THREE.InstancedBufferAttribute(opacityData, 1, false);
    this.opacityAttr.setUsage(THREE.DynamicDrawUsage);

    this.instancedGeo.setAttribute("instanceTranslation", this.translationAttr);
    this.instancedGeo.setAttribute("instanceScale", this.scaleAttr);
    this.instancedGeo.setAttribute("instanceUV", this.uvAttr);
    this.instancedGeo.setAttribute("instanceOpacity", this.opacityAttr);

    this.material = new THREE.ShaderMaterial({
      vertexShader: LABEL_VERT,
      fragmentShader: LABEL_FRAG,
      uniforms: {
        uAtlas: { value: this.atlasTexture },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.instancedMesh = new THREE.Mesh(this.instancedGeo, this.material);
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.renderOrder = 999;
    this.scene.add(this.instancedMesh);
  }

  public updateVisibilityAndOcclusion(
    camera: THREE.Camera,
    positions: Float32Array,
    settings: Graph3DPluginSettings,
    hoveredNodeId: string | null = null,
    highlightedNodeIds: Set<string> = new Set(),
  ): void {
    if (
      !this.opacityAttr ||
      !this.translationAttr ||
      this.labelCount === 0 ||
      !settings.showNodeLabels ||
      settings.performanceMode
    ) {
      if (this.instancedMesh) this.instancedMesh.visible = false;
      return;
    }

    if (this.instancedMesh) this.instancedMesh.visible = true;

    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const trans = this.translationAttr.array as Float32Array;
    const opacities = this.opacityAttr.array as Float32Array;
    const stride = this.positionsStride;

    const visibleDistance = settings.labelDistance;
    const fadeStartDistance = visibleDistance * settings.labelFadeThreshold;
    const visibleDistSq = visibleDistance * visibleDistance;
    const fadeStartDistSq = fadeStartDistance * fadeStartDistance;

    const camPos = camera.position;
    const checkOcclusion = settings.labelOcclusion;
    const hoverOnly = settings.showLabelsOnHoverOnly;

    // First pass: update positions and compute distance fade
    for (let i = 0; i < this.labelCount; i++) {
      const src = i * stride;
      const dst = i * 3;
      const label = this.labels[i];

      const x = positions[src];
      const y = positions[src + 1] + label.size * 0.6 + 2.0; // Place above node
      const z = positions[src + 2];

      trans[dst] = x;
      trans[dst + 1] = y;
      trans[dst + 2] = z;

      if (hoverOnly) {
        const isHovered = hoveredNodeId !== null && label.id === hoveredNodeId;
        const isHighlighted = highlightedNodeIds.has(label.id);
        if (!isHovered && !isHighlighted) {
          opacities[i] = 0.0;
          continue;
        }
      }

      this.tempNodePos.set(x, y, z);

      if (!this.frustum.containsPoint(this.tempNodePos)) {
        opacities[i] = 0.0;
        continue;
      }

      const distSq = camPos.distanceToSquared(this.tempNodePos);
      if (distSq > visibleDistSq) {
        opacities[i] = 0.0;
        continue;
      }

      let opacity = 1.0;
      if (distSq > fadeStartDistSq) {
        const dist = Math.sqrt(distSq);
        opacity = 1.0 - (dist - fadeStartDistance) / (visibleDistance - fadeStartDistance);
      }

      // Fast analytical ray-sphere occlusion (Item 3)
      if (opacity > 0.01 && checkOcclusion) {
        const rayDir = this.tempCamToNode.subVectors(this.tempNodePos, camPos).normalize();
        const maxDist = Math.sqrt(distSq);

        let occluded = false;
        // Test against candidate nodes
        for (let j = 0; j < this.labelCount; j++) {
          if (j === i) continue;
          const otherSrc = j * stride;
          const ox = positions[otherSrc] - camPos.x;
          const oy = positions[otherSrc + 1] - camPos.y;
          const oz = positions[otherSrc + 2] - camPos.z;

          // Projection along ray
          const dot = ox * rayDir.x + oy * rayDir.y + oz * rayDir.z;
          if (dot <= 1.0 || dot >= maxDist - 1.0) continue;

          // Perpendicular distance squared
          const oDistSq = ox * ox + oy * oy + oz * oz;
          const perpDistSq = oDistSq - dot * dot;
          const nodeRadius = this.labels[j].size;

          if (perpDistSq <= nodeRadius * nodeRadius) {
            occluded = true;
            break;
          }
        }

        if (occluded) {
          opacity = 0.0;
        }
      }

      opacities[i] = opacity;
    }

    this.translationAttr.needsUpdate = true;
    this.opacityAttr.needsUpdate = true;
  }

  private hexToRgba(hex: string, alpha: number): string {
    const cleanHex = hex.replace("#", "");
    const r = parseInt(cleanHex.substring(0, 2), 16) || 0;
    const g = parseInt(cleanHex.substring(2, 4), 16) || 0;
    const b = parseInt(cleanHex.substring(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  public clear(): void {
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedGeo?.dispose();
      this.material?.dispose();
      this.instancedMesh = null;
      this.instancedGeo = null;
      this.translationAttr = null;
      this.scaleAttr = null;
      this.uvAttr = null;
      this.opacityAttr = null;
      this.material = null;
    }
    if (this.atlasTexture) {
      this.atlasTexture.dispose();
      this.atlasTexture = null;
    }
    this.labelCache.clear();
    this.labels = [];
    this.labelCount = 0;
  }
}
