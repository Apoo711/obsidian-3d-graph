import ForceGraph3D from "3d-force-graph";
import {
  debounce,
  getAllTags,
  ItemView,
  Setting,
  setIcon,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import * as THREE from "three";
import type Graph3DPlugin from "../main";
import { PhysicsBridge } from "./physics/physics-bridge";
import { createWorkerBlobUrl, getWasmArrayBuffer } from "./physics/wasm-loader";
import { InstancedGraphRenderer } from "./rendering/graph-renderer";
import { InstancedLabelRenderer } from "./rendering/label-renderer";
import {
  ColorGroup,
  type Filter,
  type Graph3DPluginSettings,
  type GraphLink,
  type GraphNode,
  NodeShape,
  NodeType,
} from "./types";

export const VIEW_TYPE_3D_GRAPH = "3d-graph-view";

interface ProcessedGraphLink {
  source: GraphNode;
  target: GraphNode;
}

interface PreprocessedGroup {
  color: string;
  query: string;
  type: "path" | "tag" | "file" | "text";
  pathQuery?: string;
  tagQuery?: string;
  fileQuery?: string;
  fileRegex?: RegExp;
}

export class Graph3DView extends ItemView {
  private graph: any;
  private plugin: Graph3DPlugin;
  private settings: Graph3DPluginSettings;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();

  private instancedRenderer: InstancedGraphRenderer | null = null;
  private labelRenderer: InstancedLabelRenderer | null = null;
  private currentPositions: Float32Array = new Float32Array(0);
  private currentNodes: GraphNode[] = [];
  private currentLinks: GraphLink[] = [];
  private nodeIdToIndex = new Map<string, number>();
  private linkToIndex = new Map<GraphLink, number>();

  private reusableNodePosition = new THREE.Vector3();
  private reusableDirection = new THREE.Vector3();
  private cachedOccluders: THREE.Mesh[] = [];
  private occludersCacheDirty = true;
  private readonly RAYCAST_CULL_DISTANCE = 800;

  private nodeMeshes = new WeakMap<GraphNode, THREE.Mesh>();

  private highlightedNodes = new Set<string>();
  private highlightedLinks = new Set<object>();
  private selectedNode: string | null = null;
  private hoveredNode: GraphNode | null = null;

  private colorCache = new Map<string, string>();
  private colorResolverEl: HTMLDivElement | null = null;
  private colorCanvasCtx: CanvasRenderingContext2D | null = null;

  private graphContainer: HTMLDivElement;
  private messageEl: HTMLDivElement;
  private counterEl: HTMLDivElement;
  private settingsPanel: HTMLDivElement;
  private settingsToggleButton: HTMLDivElement;

  private chargeForce: any;
  private centerForce: any;
  private linkForce: any;
  private physicsBridge = new PhysicsBridge();

  private clickTimeout: any = null;
  private isGraphInitialized = false;
  private isUpdating = false;
  private readonly CLICK_DELAY = 250;

  private lastLabelUpdateTime = 0;
  private readonly LABEL_UPDATE_INTERVAL = 100;

  private pressedKeys = new Set<string>();

  private idleRotateFrame: number | null = null;
  private lastIdleRotateTime = 0;
  private lastInteractionTime = -Infinity;
  private readonly IDLE_ROTATE_DELAY = 3000;
  private idleRotateOffset = new THREE.Vector3();

  private fileContentCache = new Map<
    string,
    { mtime: number; content: string; lowerCaseContent: string }
  >();
  private processedNodes = new Map<string, { node: GraphNode; mtime: number }>();
  private nodeMap = new Map<string, GraphNode>();
  private reciprocalLinks = new Set<string>();
  private linkAdjacencyIndex = new Map<string, ProcessedGraphLink[]>();
  private lastHighlightedNodes = new Set<string>();
  private preprocessedGroups: PreprocessedGroup[] = [];
  private groupsDirty = true;

  private keyboardDirection = new THREE.Vector3();
  private keyboardRight = new THREE.Vector3();
  private keyboardMoveVector = new THREE.Vector3();
  private keyboardNewPos = new THREE.Vector3();
  private keyboardNewTarget = new THREE.Vector3();

  private reusableTargetPosition = new THREE.Vector3();

  private dragSyncBuffer: Float32Array = new Float32Array(0);

  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private geometryCache = new Map<NodeShape, THREE.BufferGeometry>();
  private materialCache = new Map<string, THREE.MeshLambertMaterial>();
  private controlsListenerAdded = false;

  constructor(leaf: WorkspaceLeaf, plugin: Graph3DPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  private getSharedGeometry(shape: NodeShape): THREE.BufferGeometry {
    let geometry = this.geometryCache.get(shape);
    if (!geometry) {
      const perf = this.settings.performanceMode;
      switch (shape) {
        case NodeShape.Cube:
          geometry = new THREE.BoxGeometry(1, 1, 1);
          break;
        case NodeShape.Pyramid:
          geometry = new THREE.ConeGeometry(1 / 1.5, 1, perf ? 3 : 4);
          break;
        case NodeShape.Tetrahedron:
          geometry = new THREE.TetrahedronGeometry(1 / 1.2);
          break;
        default:
          geometry = new THREE.SphereGeometry(0.5, perf ? 8 : 16, perf ? 6 : 12);
      }
      this.geometryCache.set(shape, geometry);
    }
    return geometry;
  }

  private getSharedMaterial(color: string): THREE.MeshLambertMaterial {
    let material = this.materialCache.get(color);
    if (!material) {
      material = new THREE.MeshLambertMaterial({
        color: color,
        transparent: true,
        opacity: 0.9,
      });
      this.materialCache.set(color, material);
    }
    return material;
  }

  public clearResourceCaches() {
    this.geometryCache.forEach((g) => g.dispose());
    this.geometryCache.clear();
    this.materialCache.forEach((m) => m.dispose());
    this.materialCache.clear();
  }

  getViewType() {
    return VIEW_TYPE_3D_GRAPH;
  }
  getDisplayText() {
    return "3d graph";
  }

  async onOpen() {
    const rootContainer = this.contentEl;
    rootContainer.empty();
    rootContainer.addClass("graph-3d-view-content");

    const viewWrapper = rootContainer.createEl("div", {
      cls: "graph-3d-view-wrapper",
    });

    this.graphContainer = viewWrapper.createEl("div", {
      cls: "graph-3d-container",
      attr: { tabindex: "0" },
    });
    this.messageEl = viewWrapper.createEl("div", {
      cls: "graph-3d-message",
    });
    this.counterEl = viewWrapper.createEl("div", {
      cls: "graph-3d-counter",
    });

    this.addLocalControls();
    this.initializeGraph();

    const debouncedResize = debounce(
      () => {
        if (this.graph && this.isGraphInitialized) {
          this.graph.width(this.graphContainer.offsetWidth);
          this.graph.height(this.graphContainer.offsetHeight);
        }
      },
      150,
      false,
    );

    this.resizeObserver = new ResizeObserver(() => debouncedResize());
    this.resizeObserver.observe(this.graphContainer);

    this.registerDomEvent(this.graphContainer, "keydown", this.handleKeyDown.bind(this));
    this.registerDomEvent(this.graphContainer, "keyup", this.handleKeyUp.bind(this));

    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.colorCache.clear();
        if (this.isGraphInitialized) {
          this.updateColors();
        }
      }),
    );
  }

  private addLocalControls() {
    const controlsContainer = this.contentEl.createEl("div", {
      cls: "graph-3d-controls-container",
    });

    const resetViewButton = controlsContainer.createEl("div", {
      cls: "graph-3d-reset-toggle",
    });
    setIcon(resetViewButton, "refresh-cw");
    resetViewButton.setAttribute("aria-label", "Reset view");
    resetViewButton.addEventListener("click", () => {
      if (this.graph && this.isGraphInitialized) {
        this.graph.zoomToFit(800);
      }
    });

    this.settingsToggleButton = controlsContainer.createEl("div", {
      cls: "graph-3d-settings-toggle",
    });
    setIcon(this.settingsToggleButton, "settings");
    this.settingsToggleButton.setAttribute("aria-label", "Graph settings");
    this.settingsPanel = controlsContainer.createEl("div", {
      cls: "graph-3d-settings-panel",
    });
    this.settingsToggleButton.addEventListener("click", () => {
      this.settingsPanel.classList.toggle("is-open");
    });
    this.renderSettingsPanel();
  }

  public renderSettingsPanel() {
    this.settingsPanel.empty();
    this.renderSearchSettings(this.settingsPanel);
    this.renderAdvancedFilters(this.settingsPanel);
    this.renderFilterSettings(this.settingsPanel);
    this.renderGroupSettings(this.settingsPanel);
    this.renderAppearanceSettings(this.settingsPanel);
    this.renderLabelSettings(this.settingsPanel);
    this.renderInteractionSettings(this.settingsPanel);
    this.renderForceSettings(this.settingsPanel);
  }

  public isSettingsPanelOpen(): boolean {
    return this.settingsPanel?.classList.contains("is-open");
  }

  private renderSearchSettings(container: HTMLElement) {
    new Setting(container).setHeading().setName("Search");
    new Setting(container).setName("Search term").addText((text) =>
      text.setValue(this.settings.searchQuery).onChange(
        debounce(
          async (value) => {
            this.settings.searchQuery = value.trim();
            await this.plugin.saveSettings();
            this.updateData({ useCache: true, reheat: false });
          },
          500,
          true,
        ),
      ),
    );
    new Setting(container)
      .setName("Show neighboring nodes")
      .setDesc("Show nodes linked to search/filter results.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.showNeighboringNodes).onChange(async (value) => {
          this.settings.showNeighboringNodes = value;
          await this.plugin.saveSettings();
          this.updateData({ useCache: true, reheat: false });
        }),
      );
  }

  private renderAdvancedFilters(container: HTMLElement) {
    new Setting(container).setHeading().setName("Advanced Filters");

    this.settings.filters.forEach((filter, index) => {
      const setting = new Setting(container)
        .addDropdown((dropdown) =>
          dropdown
            .addOption("path", "Path")
            .addOption("tag", "Tag")
            .onChange(async (value: string) => {
              filter.type = value as "path" | "tag";
              await this.plugin.saveSettings();
              this.updateData({ useCache: true });
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder("Enter filter value...")
            .setValue(filter.value)
            .onChange(
              debounce(
                async (value) => {
                  filter.value = value;
                  await this.plugin.saveSettings();
                  this.updateData({ useCache: true });
                },
                500,
                true,
              ),
            ),
        )
        .addToggle((toggle) => {
          toggle
            .setTooltip("Enable/Disable filter")
            .setValue(filter.enabled)
            .onChange(async (value) => {
              filter.enabled = value;
              await this.plugin.saveSettings();
              this.updateData({ useCache: true });
            });
        })
        .addExtraButton((button) =>
          button
            .setIcon("cross")
            .setTooltip("Remove filter")
            .onClick(async () => {
              this.settings.filters.splice(index, 1);
              await this.plugin.saveSettings();
              this.renderSettingsPanel();
              this.updateData({ useCache: true });
            }),
        );
    });

    new Setting(container).addButton((button) =>
      button.setButtonText("Add new filter").onClick(async () => {
        this.settings.filters.push({
          type: "path",
          value: "",
          enabled: true,
        });
        await this.plugin.saveSettings();
        this.renderSettingsPanel();
      }),
    );
  }

  private renderFilterSettings(container: HTMLElement) {
    new Setting(container).setHeading().setName("General Filters");

    new Setting(container).setName("Show tags").addToggle((toggle) =>
      toggle.setValue(this.settings.showTags).onChange(async (value) => {
        this.settings.showTags = value;
        await this.plugin.saveSettings();
        this.updateData({ useCache: true, reheat: false });
      }),
    );

    new Setting(container).setName("Show attachments").addToggle((toggle) =>
      toggle.setValue(this.settings.showAttachments).onChange(async (value) => {
        this.settings.showAttachments = value;
        await this.plugin.saveSettings();
        this.updateData({ useCache: true, reheat: false });
      }),
    );

    new Setting(container).setName("Hide orphans").addToggle((toggle) =>
      toggle.setValue(this.settings.hideOrphans).onChange(async (value) => {
        this.settings.hideOrphans = value;
        await this.plugin.saveSettings();
        this.updateData({ useCache: true, reheat: false });
      }),
    );
  }

  private renderGroupSettings(container: HTMLElement) {
    const groupContainer = container.createDiv();
    const render = () => {
      groupContainer.empty();
      new Setting(groupContainer).setHeading().setName("Color Groups");

      this.settings.groups.forEach((group, index) => {
        new Setting(groupContainer)
          .addText((text) =>
            text
              .setPlaceholder("path:, tag:, file:, or text")
              .setValue(group.query)
              .onChange(async (value) => {
                group.query = value;
                await this.plugin.saveSettings();
                this.updateColors();
              }),
          )
          .addColorPicker((color) =>
            color.setValue(group.color).onChange(async (value) => {
              group.color = value;
              await this.plugin.saveSettings();
              this.updateColors();
            }),
          )
          .addExtraButton((button) =>
            button
              .setIcon("cross")
              .setTooltip("Remove group")
              .onClick(async () => {
                this.settings.groups.splice(index, 1);
                await this.plugin.saveSettings();
                render();
                this.updateColors();
              }),
          );
      });

      new Setting(groupContainer).addButton((button) =>
        button.setButtonText("Add new group").onClick(async () => {
          this.settings.groups.push({ query: "", color: "#ffffff" });
          await this.plugin.saveSettings();
          render();
        }),
      );
    };
    render();
  }

  private renderAppearanceSettings(container: HTMLElement) {
    new Setting(container).setHeading().setName("Appearance");

    const updateDisplayAndColors = async () => {
      await this.plugin.saveSettings();
      this.updateDisplay();
    };

    new Setting(container).setName("Node size").addSlider((s) =>
      s
        .setLimits(0.1, 5, 0.1)
        .setValue(this.settings.nodeSize)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.nodeSize = v;
          await updateDisplayAndColors();
        }),
    );
    new Setting(container).setName("Tag node size").addSlider((s) =>
      s
        .setLimits(0.1, 5, 0.1)
        .setValue(this.settings.tagNodeSize)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.tagNodeSize = v;
          await updateDisplayAndColors();
        }),
    );
    new Setting(container).setName("Attachment node size").addSlider((s) =>
      s
        .setLimits(0.1, 5, 0.1)
        .setValue(this.settings.attachmentNodeSize)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.attachmentNodeSize = v;
          await updateDisplayAndColors();
        }),
    );
    new Setting(container).setName("Link thickness").addSlider((s) =>
      s
        .setLimits(0.1, 5, 0.1)
        .setValue(this.settings.linkThickness)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.linkThickness = v;
          await updateDisplayAndColors();
        }),
    );

    new Setting(container).setName("Node shape").addDropdown((dd) =>
      dd
        .addOptions(NodeShape)
        .setValue(this.settings.nodeShape)
        .onChange(async (value: string) => {
          this.settings.nodeShape = value as NodeShape;
          await updateDisplayAndColors();
        }),
    );
    new Setting(container).setName("Tag shape").addDropdown((dd) =>
      dd
        .addOptions(NodeShape)
        .setValue(this.settings.tagShape)
        .onChange(async (value: string) => {
          this.settings.tagShape = value as NodeShape;
          await updateDisplayAndColors();
        }),
    );
    new Setting(container).setName("Attachment shape").addDropdown((dd) =>
      dd
        .addOptions(NodeShape)
        .setValue(this.settings.attachmentShape)
        .onChange(async (value: string) => {
          this.settings.attachmentShape = value as NodeShape;
          await updateDisplayAndColors();
        }),
    );
  }

  private renderLabelSettings(container: HTMLElement) {
    new Setting(container).setHeading().setName("Labels");

    new Setting(container).setName("Show labels on hover/highlight only").addToggle((toggle) =>
      toggle.setValue(this.settings.showLabelsOnHoverOnly).onChange(async (value) => {
        this.settings.showLabelsOnHoverOnly = value;
        await this.plugin.saveSettings();
        this.updateDisplay();
      }),
    );

    new Setting(container).setName("Label distance").addSlider((s) =>
      s
        .setLimits(50, 500, 10)
        .setValue(this.settings.labelDistance)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.labelDistance = v;
          await this.plugin.saveSettings();
        }),
    );
  }

  private renderInteractionSettings(container: HTMLElement) {
    new Setting(container).setHeading().setName("Interaction");

    new Setting(container).setName("Use Keyboard Controls (WASD)").addToggle((toggle) =>
      toggle.setValue(this.settings.useKeyboardControls).onChange(async (value) => {
        this.settings.useKeyboardControls = value;
        await this.plugin.saveSettings();
        this.updateControls();
      }),
    );

    new Setting(container).setName("Keyboard move speed").addSlider((s) =>
      s
        .setLimits(0.1, 10, 0.1)
        .setValue(this.settings.keyboardMoveSpeed)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.keyboardMoveSpeed = v;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(container).setName("Zoom on click").addToggle((toggle) =>
      toggle.setValue(this.settings.zoomOnClick).onChange(async (value) => {
        this.settings.zoomOnClick = value;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(container).setName("Rotation speed").addSlider((s) =>
      s
        .setLimits(0.1, 5, 0.1)
        .setValue(this.settings.rotateSpeed)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.rotateSpeed = v;
          await this.plugin.saveSettings();
          this.updateControls();
        }),
    );

    new Setting(container).setName("Auto-rotate when idle").addToggle((toggle) =>
      toggle.setValue(this.settings.idleRotate).onChange(async (value) => {
        this.settings.idleRotate = value;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(container).setName("Auto-rotate speed (deg/s)").addSlider((s) =>
      s
        .setLimits(1, 30, 1)
        .setValue(this.settings.idleRotateSpeed)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.idleRotateSpeed = v;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(container).setName("Pan speed").addSlider((s) =>
      s
        .setLimits(0.1, 5, 0.1)
        .setValue(this.settings.panSpeed)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.panSpeed = v;
          await this.plugin.saveSettings();
          this.updateControls();
        }),
    );

    new Setting(container).setName("Zoom speed").addSlider((s) =>
      s
        .setLimits(0.1, 5, 0.1)
        .setValue(this.settings.zoomSpeed)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.settings.zoomSpeed = v;
          await this.plugin.saveSettings();
          this.updateControls();
        }),
    );
  }

  private renderForceSettings(container: HTMLElement) {
    new Setting(container).setHeading().setName("Forces");

    const forceChangeHandler = async () => {
      await this.plugin.saveSettings();
      this.updateData({ useCache: false, reheat: true });
    };

    new Setting(container).setName("Center force").addSlider((slider) =>
      slider
        .setLimits(0, 1, 0.01)
        .setValue(this.settings.centerForce)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.settings.centerForce = value;
          await forceChangeHandler();
        }),
    );

    new Setting(container).setName("Repel force").addSlider((slider) =>
      slider
        .setLimits(0, 20, 0.1)
        .setValue(this.settings.repelForce)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.settings.repelForce = value;
          await forceChangeHandler();
        }),
    );
  }

  private initializeForces() {
    this.chargeForce = this.graph.d3Force("charge");
    this.centerForce = this.graph.d3Force("center");
    this.linkForce = this.graph.d3Force("link");
  }

  private handleKeyDown(event: KeyboardEvent) {
    const movementKeys = ["w", "a", "s", "d", "q", "e"];
    const key = event.key.toLowerCase();

    if (this.settings.useKeyboardControls && movementKeys.includes(key)) {
      event.preventDefault();
      this.pressedKeys.add(key);
    }
  }

  private handleKeyUp(event: KeyboardEvent) {
    if (this.settings.useKeyboardControls) {
      this.pressedKeys.delete(event.key.toLowerCase());
    }
  }

  private handleKeyboardMovement() {
    if (!this.settings.useKeyboardControls || this.pressedKeys.size === 0) return;

    const controls = this.graph.controls();
    const camera = this.graph.camera();
    if (!controls || !camera) return;

    const moveSpeed = this.settings.keyboardMoveSpeed;
    camera.getWorldDirection(this.keyboardDirection);

    this.keyboardRight.crossVectors(this.keyboardDirection, camera.up).normalize();

    this.keyboardMoveVector.set(0, 0, 0);

    if (this.pressedKeys.has("w")) this.keyboardMoveVector.add(this.keyboardDirection);
    if (this.pressedKeys.has("s")) this.keyboardMoveVector.sub(this.keyboardDirection);
    if (this.pressedKeys.has("a")) this.keyboardMoveVector.sub(this.keyboardRight);
    if (this.pressedKeys.has("d")) this.keyboardMoveVector.add(this.keyboardRight);

    if (this.keyboardMoveVector.lengthSq() > 0) {
      this.keyboardMoveVector.normalize().multiplyScalar(moveSpeed);
      this.keyboardNewPos.copy(camera.position).add(this.keyboardMoveVector);
      this.keyboardNewTarget.copy(controls.target).add(this.keyboardMoveVector);
      this.graph.cameraPosition(this.keyboardNewPos, this.keyboardNewTarget);
    }

    if (this.pressedKeys.has("e")) {
      this.keyboardNewPos.copy(camera.position);
      this.keyboardNewPos.y += moveSpeed;
      this.keyboardNewTarget.copy(controls.target);
      this.keyboardNewTarget.y += moveSpeed;
      this.graph.cameraPosition(this.keyboardNewPos, this.keyboardNewTarget);
    }
    if (this.pressedKeys.has("q")) {
      this.keyboardNewPos.copy(camera.position);
      this.keyboardNewPos.y -= moveSpeed;
      this.keyboardNewTarget.copy(controls.target);
      this.keyboardNewTarget.y -= moveSpeed;
      this.graph.cameraPosition(this.keyboardNewPos, this.keyboardNewTarget);
    }
  }

  private syncDragPositionsToWasm() {
    if (!this.settings.useWasmPhysics || this.currentPositions.length === 0) return;
    if (this.dragSyncBuffer.length !== this.currentPositions.length) {
      this.dragSyncBuffer = new Float32Array(this.currentPositions.length);
    }
    // currentPositions already holds the dragged node's live position. Overwriting it
    // with node.x/y/z (stale seed values) teleported the node on every plain click.
    this.dragSyncBuffer.set(this.currentPositions);
    this.physicsBridge.setPositions(this.dragSyncBuffer);
  }

  private setupPointerInteractions() {
    if (!this.graphContainer) return;

    let isPointerDown = false;
    let pointerDownPos = { x: 0, y: 0 };
    let draggedNode: GraphNode | null = null;
    const dragPlane = new THREE.Plane();
    const planeIntersect = new THREE.Vector3();
    const tempCamDir = new THREE.Vector3();
    const pointerNdc = new THREE.Vector2();

    const updatePointerNDC = (e: MouseEvent | PointerEvent) => {
      const rect = this.graphContainer.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      return pointerNdc;
    };

    this.registerDomEvent(this.graphContainer, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      isPointerDown = true;
      pointerDownPos = { x: e.clientX, y: e.clientY };

      if (!this.graph || !this.instancedRenderer || this.currentPositions.length === 0) return;
      const camera = this.graph.camera();
      if (!camera) return;

      const ndc = updatePointerNDC(e);
      this.raycaster.setFromCamera(ndc, camera);
      const hitIdx = this.instancedRenderer.getNodeIndexAtRay(this.raycaster, this.currentPositions);

      if (hitIdx !== null && hitIdx < this.currentNodes.length) {
        draggedNode = this.currentNodes[hitIdx];
        const controls = this.graph.controls();
        if (controls) controls.enabled = false;

        const nodePos = new THREE.Vector3(
          this.currentPositions[hitIdx * 4],
          this.currentPositions[hitIdx * 4 + 1],
          this.currentPositions[hitIdx * 4 + 2],
        );
        camera.getWorldDirection(tempCamDir);
        dragPlane.setFromNormalAndCoplanarPoint(tempCamDir.negate(), nodePos);
      }
    });

    this.registerDomEvent(this.graphContainer, "pointermove", (e: PointerEvent) => {
      if (!this.graph || !this.instancedRenderer || this.currentPositions.length === 0) return;
      const camera = this.graph.camera();
      if (!camera) return;

      const ndc = updatePointerNDC(e);
      this.raycaster.setFromCamera(ndc, camera);

      if (draggedNode && isPointerDown) {
        if (this.raycaster.ray.intersectPlane(dragPlane, planeIntersect)) {
          draggedNode.x = planeIntersect.x;
          draggedNode.y = planeIntersect.y;
          draggedNode.z = planeIntersect.z;
          const idx = this.nodeIdToIndex.get(draggedNode.id);
          if (idx !== undefined) {
            this.currentPositions[idx * 4] = planeIntersect.x;
            this.currentPositions[idx * 4 + 1] = planeIntersect.y;
            this.currentPositions[idx * 4 + 2] = planeIntersect.z;
          }
          this.instancedRenderer.updatePositions(this.currentPositions);
          this.syncDragPositionsToWasm();
        }
      } else {
        const hitIdx = this.instancedRenderer.getNodeIndexAtRay(this.raycaster, this.currentPositions);
        const node = hitIdx !== null ? this.currentNodes[hitIdx] : null;
        if (node !== this.hoveredNode) {
          this.handleNodeHover(node);
        }
      }
    });

    const onPointerUp = () => {
      if (draggedNode) {
        this.syncDragPositionsToWasm();
        draggedNode = null;
        const controls = this.graph?.controls();
        if (controls) controls.enabled = true;
      }
      isPointerDown = false;
    };

    this.registerDomEvent(this.graphContainer, "pointerup", onPointerUp);
    this.registerDomEvent(this.graphContainer, "pointerleave", onPointerUp);

    this.registerDomEvent(this.graphContainer, "click", (e: MouseEvent) => {
      const distSq = (e.clientX - pointerDownPos.x) ** 2 + (e.clientY - pointerDownPos.y) ** 2;
      if (distSq > 25) return;

      if (!this.graph || !this.instancedRenderer || this.currentPositions.length === 0) return;
      const camera = this.graph.camera();
      if (!camera) return;

      const ndc = updatePointerNDC(e);
      this.raycaster.setFromCamera(ndc, camera);
      const hitIdx = this.instancedRenderer.getNodeIndexAtRay(this.raycaster, this.currentPositions);

      if (hitIdx !== null && hitIdx < this.currentNodes.length) {
        this.handleNodeClick(this.currentNodes[hitIdx], e);
      } else {
        if (this.selectedNode !== null || this.highlightedNodes.size > 0) {
          this.selectedNode = null;
          this.highlightedNodes.clear();
          this.highlightedLinks.clear();
          this.updateColors();
        }
      }
    });

    this.registerDomEvent(this.graphContainer, "dblclick", (e: MouseEvent) => {
      if (!this.graph || !this.instancedRenderer || this.currentPositions.length === 0) return;
      const camera = this.graph.camera();
      if (!camera) return;

      const ndc = updatePointerNDC(e);
      this.raycaster.setFromCamera(ndc, camera);
      const hitIdx = this.instancedRenderer.getNodeIndexAtRay(this.raycaster, this.currentPositions);

      if (hitIdx !== null && hitIdx < this.currentNodes.length) {
        this.handleNodeDoubleClick(this.currentNodes[hitIdx]);
      }
    });
  }

  private idleRotateStep = (now: number) => {
    this.idleRotateFrame = requestAnimationFrame(this.idleRotateStep);
    const dt = Math.min((now - this.lastIdleRotateTime) / 1000, 0.1);
    this.lastIdleRotateTime = now;

    if (!this.settings.idleRotate || !this.graph || !this.isGraphInitialized) return;
    if (document.hidden || !this.graphContainer.isShown()) return;
    if (now - this.lastInteractionTime < this.IDLE_ROTATE_DELAY) return;

    const camera = this.graph.camera();
    const controls = this.graph.controls();
    if (!camera || !controls) return;

    const angle = THREE.MathUtils.degToRad(this.settings.idleRotateSpeed) * dt;
    this.idleRotateOffset.copy(camera.position).sub(controls.target);
    this.idleRotateOffset.applyAxisAngle(camera.up, angle);
    camera.position.copy(controls.target).add(this.idleRotateOffset);
    camera.lookAt(controls.target);
  };

  private startIdleRotation() {
    if (this.idleRotateFrame !== null) return;
    const markInteraction = () => {
      this.lastInteractionTime = performance.now();
    };
    // Zooming (wheel) keeps the rotation going; only orbit/pan input pauses it.
    this.registerDomEvent(this.graphContainer, "pointerdown", markInteraction);
    // A long drag must not count as idle.
    this.registerDomEvent(this.graphContainer, "pointermove", (e) => {
      if (e.buttons) markInteraction();
    });
    this.registerDomEvent(this.graphContainer, "keydown", markInteraction);
    this.idleRotateFrame = requestAnimationFrame(this.idleRotateStep);
  }

  private stopIdleRotation() {
    if (this.idleRotateFrame !== null) {
      cancelAnimationFrame(this.idleRotateFrame);
      this.idleRotateFrame = null;
    }
  }

  initializeGraph() {
    this.app.workspace.onLayoutReady(async () => {
      if (!this.graphContainer) return;

      const Graph = (ForceGraph3D as any).default || ForceGraph3D;
      this.graph = Graph()(this.graphContainer)
        .nodeVisibility(false)
        .linkVisibility(false)
        .linkCurvature((link: ProcessedGraphLink) => this.getLinkCurvature(link))
        .onEngineTick(() => {
          this.handleKeyboardMovement();
        });

      const scene = this.graph.scene();
      this.instancedRenderer = new InstancedGraphRenderer(scene);
      this.labelRenderer = new InstancedLabelRenderer(scene);

      this.setupPointerInteractions();

      this.graph.graphData({ nodes: [], links: [] });

      this.initializeForces();
      this.graph.pauseAnimation();
      this.isGraphInitialized = true;
      this.startIdleRotation();

      setTimeout(() => {
        this.updateData({ isFirstLoad: true });
      }, 100);
    });
  }

  public async updateData(
    options: { useCache?: boolean; reheat?: boolean; isFirstLoad?: boolean } = {},
  ) {
    const { useCache = true, reheat = false, isFirstLoad = false } = options;

    if (!this.isGraphInitialized || this.isUpdating) {
      return;
    }
    this.isUpdating = true;

    this.updatePreprocessedGroups();

    try {
      const nodePositions = new Map<string, { x: number; y: number; z: number }>();
      if (useCache && this.graph.graphData().nodes.length > 0) {
        this.graph.graphData().nodes.forEach((node: GraphNode) => {
          if (node.id && node.x !== undefined && node.y !== undefined && node.z !== undefined) {
            nodePositions.set(node.id, {
              x: node.x,
              y: node.y,
              z: node.z,
            });
          }
        });
      }

      const prevPositions = new Map<string, [number, number, number]>();
      if (useCache) {
        const stride = this.physicsBridge.positionsStride;
        const pos = this.currentPositions;
        this.currentNodes.forEach((n, i) => {
          const o = i * stride;
          if (o + 2 < pos.length) prevPositions.set(n.id, [pos[o], pos[o + 1], pos[o + 2]]);
        });
      }

      const newData = await this.processVaultData();
      const hasNodes = newData && newData.nodes.length > 0;

      const oldNodes = this.graph.graphData().nodes as GraphNode[];
      if (oldNodes.length > 0) {
        const newNodeIds = new Set(hasNodes ? newData.nodes.map((n) => n.id) : []);
        const nodesToRemove = oldNodes.filter((node) => !newNodeIds.has(node.id));
        nodesToRemove.forEach((node) => this.cleanupNode(node));
      }

      if (hasNodes) {
        if (useCache) {
          const adjacencyMap: Map<string, string[]> = new Map();
          newData.links.forEach((link) => {
            const sourceId = link.source as string;
            const targetId = link.target as string;

            if (!adjacencyMap.has(sourceId)) adjacencyMap.set(sourceId, []);
            if (!adjacencyMap.has(targetId)) adjacencyMap.set(targetId, []);

            adjacencyMap.get(sourceId)!.push(targetId);
            adjacencyMap.get(targetId)!.push(sourceId);
          });

          newData.nodes.forEach((node) => {
            const cachedPos = nodePositions.get(node.id);
            if (cachedPos) {
              node.x = cachedPos.x;
              node.y = cachedPos.y;
              node.z = cachedPos.z;
            } else {
              const neighbors = adjacencyMap.get(node.id) || [];
              let connectedNodePos: { x: number; y: number; z: number } | undefined;

              for (const neighborId of neighbors) {
                connectedNodePos = nodePositions.get(neighborId);
                if (connectedNodePos) break;
              }

              if (connectedNodePos) {
                node.x = connectedNodePos.x + (Math.random() - 0.5) * 2;
                node.y = connectedNodePos.y + (Math.random() - 0.5) * 2;
                node.z = connectedNodePos.z + (Math.random() - 0.5) * 2;
              }
            }
          });
        }

        this.graph.pauseAnimation();
        this.messageEl.removeClass("is-visible");

        this.reciprocalLinks.clear();
        const seenLinks = new Set<string>();
        const linksCount = newData.links.length;
        for (let i = 0; i < linksCount; i++) {
          const link = newData.links[i];
          const src = typeof link.source === "object" ? (link.source as GraphNode).id : (link.source as string);
          const tgt = typeof link.target === "object" ? (link.target as GraphNode).id : (link.target as string);
          const directKey = `${src}->${tgt}`;
          const reverseKey = `${tgt}->${src}`;
          if (seenLinks.has(reverseKey)) {
            this.reciprocalLinks.add(directKey);
            this.reciprocalLinks.add(reverseKey);
          }
          seenLinks.add(directKey);
        }

        this.nodeMap.clear();
        newData.nodes.forEach((node) => {
          this.nodeMap.set(node.id, node);
        });

        this.currentNodes = newData.nodes;
        this.currentLinks = newData.links;
        this.nodeIdToIndex.clear();
        newData.nodes.forEach((n: GraphNode, idx: number) => this.nodeIdToIndex.set(n.id, idx));
        this.linkToIndex.clear();
        newData.links.forEach((l: GraphLink, idx: number) => this.linkToIndex.set(l, idx));

        this.graph.graphData(newData);
        this.occludersCacheDirty = true;

        this.linkAdjacencyIndex.clear();
        const processedLinks = this.graph.graphData().links as ProcessedGraphLink[];
        processedLinks.forEach((link) => {
          const sourceId =
            typeof link.source === "object"
              ? (link.source as GraphNode).id
              : (link.source as string);
          const targetId =
            typeof link.target === "object"
              ? (link.target as GraphNode).id
              : (link.target as string);

          if (!this.linkAdjacencyIndex.has(sourceId)) {
            this.linkAdjacencyIndex.set(sourceId, []);
          }
          if (!this.linkAdjacencyIndex.has(targetId)) {
            this.linkAdjacencyIndex.set(targetId, []);
          }
          this.linkAdjacencyIndex.get(sourceId)!.push(link);
          this.linkAdjacencyIndex.get(targetId)!.push(link);
        });

        if (this.counterEl) {
          this.counterEl.setText(`${newData.nodes.length} nodes · ${newData.links.length} links`);
          this.counterEl.addClass("is-visible");
        }

        if (this.settings.useWasmPhysics && hasNodes) {
          this.graph.d3AlphaDecay(1);

          const edgesList: number[] = [];
          const edgeDataList: { source: number; target: number }[] = [];
          newData.links.forEach((l: GraphLink) => {
            const srcId =
              typeof l.source === "object" ? (l.source as GraphNode).id : (l.source as string);
            const tgtId =
              typeof l.target === "object" ? (l.target as GraphNode).id : (l.target as string);
            const srcIdx = this.nodeIdToIndex.get(srcId);
            const tgtIdx = this.nodeIdToIndex.get(tgtId);
            if (srcIdx !== undefined && tgtIdx !== undefined) {
              edgesList.push(srcIdx, tgtIdx);
              edgeDataList.push({ source: srcIdx, target: tgtIdx });
            }
          });

          const nodeDataList = newData.nodes.map((n: GraphNode) => ({
            id: n.id,
            name: n.name,
            shape: this.getNodeShape(n),
            val: this.getNodeSize(n),
            color: this.getNodeColor(n),
          }));

          const linkColor = this.settings.useThemeColors
            ? this.getCssColor("--graph-line", this.settings.colorLink)
            : this.settings.colorLink;

          this.instancedRenderer?.initGraph(
            nodeDataList,
            edgeDataList,
            this.settings.nodeSize,
            linkColor,
            0.6,
          );
          this.labelRenderer?.initLabels(newData.nodes, this.settings, 4);

          this.updateForces();
          this.updateDisplay();
          this.updateControls();

          // Seed the physics with the previous layout so an update does not
          // re-explode the graph. New nodes start at the centroid of their
          // already-placed neighbors.
          let initialPositions: Float32Array | undefined;
          if (prevPositions.size > 0) {
            const stride = this.physicsBridge.positionsStride;
            const neighbors = new Map<string, string[]>();
            for (const l of newData.links) {
              const s = typeof l.source === "object" ? (l.source as GraphNode).id : (l.source as string);
              const t = typeof l.target === "object" ? (l.target as GraphNode).id : (l.target as string);
              (neighbors.get(s) ?? neighbors.set(s, []).get(s)!).push(t);
              (neighbors.get(t) ?? neighbors.set(t, []).get(t)!).push(s);
            }
            // A new node seeded on top of its neighbor gets blasted away by the repulsion,
            // so offset it by the median link length of the nodes that already have a position.
            const linkLens: number[] = [];
            for (const [id, nbs] of neighbors) {
              const a = prevPositions.get(id);
              if (!a) continue;
              for (const nb of nbs) {
                const b = prevPositions.get(nb);
                if (b && id < nb) linkLens.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
              }
            }
            linkLens.sort((x, y) => x - y);
            const seedOffset = linkLens[linkLens.length >> 1] ?? 10;
            initialPositions = new Float32Array(newData.nodes.length * stride);
            newData.nodes.forEach((n: GraphNode, i: number) => {
              let p = prevPositions.get(n.id);
              if (!p) {
                const sum = [0, 0, 0];
                let found = 0;
                for (const nb of neighbors.get(n.id) ?? []) {
                  const np = prevPositions.get(nb);
                  if (np) {
                    sum[0] += np[0];
                    sum[1] += np[1];
                    sum[2] += np[2];
                    found++;
                  }
                }
                p = found > 0
                  ? (() => {
                      const v = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
                      const k = seedOffset / (Math.hypot(v[0], v[1], v[2]) || 1);
                      return [sum[0] / found + v[0] * k, sum[1] / found + v[1] * k, sum[2] / found + v[2] * k];
                    })()
                  : [(Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100];
              }
              initialPositions!.set(p, i * stride);
            });
          }

          this.physicsBridge
            .init(
              getWasmArrayBuffer(),
              createWorkerBlobUrl(),
              newData.nodes.length,
              new Uint32Array(edgesList),
              {
                gravity: this.settings.centerForce,
                repulsion: this.settings.repelForce * 40.0,
                attraction: this.settings.linkForce,
              },
              initialPositions,
            )
            .then(() => {
              this.physicsBridge.onTick((positions) => {
                this.currentPositions = positions;
                this.instancedRenderer?.updatePositions(positions);
                if (this.settings.showNodeLabels && !this.settings.performanceMode) {
                  this.labelRenderer?.updateVisibilityAndOcclusion(
                    this.graph.camera(),
                    positions,
                    this.settings,
                    this.hoveredNode ? this.hoveredNode.id : null,
                    this.highlightedNodes,
                  );
                }
                this.handleKeyboardMovement();
              });

              // Settle the layout in one batch before animating, so the first
              // rendered frame is already calm. step_n stops early once
              // converged, so the cap only bounds work on huge graphs.
              // A seeded layout only needs a short settle: a full one lets a single new node
              // reshuffle the whole graph.
              const fullWarmup = Math.min(20000, Math.max(30, Math.floor(2000000 / newData.nodes.length)));
              const warmupSteps = initialPositions ? Math.min(200, fullWarmup) : fullWarmup;
              let warmedUp = false;
              this.physicsBridge.onTick(() => {
                if (warmedUp) return;
                warmedUp = true;
                queueMicrotask(() => this.physicsBridge.start());
              });
              this.physicsBridge.step(warmupSteps);
            })
            .catch((err) => {
              console.error(
                "[3D Graph] WASM Physics engine failed to start, falling back to D3 force engine:",
                err,
              );
            });
        } else if (isFirstLoad || reheat) {
          this.graph.d3AlphaDecay(0.0228);
          this.graph.d3VelocityDecay(0.4);
          this.graph.d3ReheatSimulation();
        } else if (useCache) {
          this.graph.d3AlphaDecay(0.1);
          this.graph.d3VelocityDecay(0.6);
        }

        this.graph.resumeAnimation();
      } else {
        this.graph.graphData({ nodes: [], links: [] });
        this.instancedRenderer?.clear();
        this.labelRenderer?.clear();
        this.currentPositions = new Float32Array(0);
        this.currentNodes = [];
        this.currentLinks = [];
        this.colorCache.clear();
        const bgColor = this.settings.useThemeColors
          ? this.getCssColor("--background-primary", "#000000")
          : this.settings.backgroundColor;
        this.graph.backgroundColor(bgColor);
        this.messageEl.setText("No search results or filters matched.");
        this.messageEl.addClass("is-visible");
        if (this.counterEl) {
          this.counterEl.setText("");
          this.counterEl.removeClass("is-visible");
        }
        this.graph.pauseAnimation();
      }
    } catch (error) {
      console.error("3D Graph: An error occurred during updateData:", error);
    } finally {
      this.isUpdating = false;
    }
  }

  public updateColors() {
    if (!this.isGraphInitialized) return;

    this.updatePreprocessedGroups();

    const bgColor = this.settings.useThemeColors
      ? this.getCssColor("--background-primary", "#000000")
      : this.settings.backgroundColor;
    this.graph.backgroundColor(bgColor);

    if (this.instancedRenderer && this.currentNodes.length > 0) {
      const colorMap = new Map<number, string>();
      this.currentNodes.forEach((node, idx) => {
        colorMap.set(idx, this.getNodeColor(node));
      });
      this.instancedRenderer.updateNodeColors(colorMap);

      const linkHighlightColor = this.settings.useThemeColors
        ? this.getCssColor("--graph-node-focused", this.settings.colorHighlight)
        : this.settings.colorHighlight;
      const linkColor = this.settings.useThemeColors
        ? this.getCssColor("--graph-line", this.settings.colorLink)
        : this.settings.colorLink;

      const highlightedEdgeIndices = new Set<number>();
      this.highlightedLinks.forEach((linkObj) => {
        const idx = this.linkToIndex.get(linkObj as GraphLink);
        if (idx !== undefined) highlightedEdgeIndices.add(idx);
      });
      this.instancedRenderer.updateEdgeColors(highlightedEdgeIndices, linkHighlightColor, linkColor);
    }

    if (this.labelRenderer && this.currentPositions.length > 0) {
      this.labelRenderer.updateVisibilityAndOcclusion(
        this.graph.camera(),
        this.currentPositions,
        this.settings,
        this.hoveredNode ? this.hoveredNode.id : null,
        this.highlightedNodes,
      );
    }
  }

  private getCssColor(variable: string, fallback: string): string {
    if (this.colorCache.has(variable)) {
      return this.colorCache.get(variable)!;
    }

    try {
      const varName = variable.startsWith("--")
        ? variable
        : `--${variable.replace(/^var\(/, "").replace(/\)$/, "")}`;

      if (!this.colorResolverEl) {
        this.colorResolverEl = document.createElement("div");
        this.colorResolverEl.style.display = "none";
        document.body.appendChild(this.colorResolverEl);
      }
      this.colorResolverEl.style.color = `var(${varName})`;
      const computed = getComputedStyle(this.colorResolverEl).color;

      if (!this.colorCanvasCtx) {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        this.colorCanvasCtx = canvas.getContext("2d", { willReadFrequently: true });
      }

      if (this.colorCanvasCtx && computed) {
        this.colorCanvasCtx.fillStyle = computed;
        this.colorCanvasCtx.fillRect(0, 0, 1, 1);
        const [r, g, b] = this.colorCanvasCtx.getImageData(0, 0, 1, 1).data;
        const finalColor = `rgb(${r}, ${g}, ${b})`;
        this.colorCache.set(variable, finalColor);
        return finalColor;
      }

      if (computed && (computed.startsWith("#") || computed.startsWith("rgb"))) {
        this.colorCache.set(variable, computed);
        return computed;
      }
    } catch (e) {
      console.error(`3D Graph: Could not parse CSS color variable ${variable}`, e);
    }

    this.colorCache.set(variable, fallback);
    return fallback;
  }

  public setGroupsDirty() {
    this.groupsDirty = true;
  }

  private updatePreprocessedGroups() {
    if (!this.groupsDirty) return;
    this.preprocessedGroups = this.settings.groups
      .map((group) => {
        const query = group.query.toLowerCase();
        if (!query) {
          return {
            color: group.color,
            query: "",
            type: "text" as const,
          };
        }

        if (query.startsWith("path:")) {
          return {
            color: group.color,
            query,
            type: "path" as const,
            pathQuery: query.substring(5).trim(),
          };
        } else if (query.startsWith("tag:")) {
          return {
            color: group.color,
            query,
            type: "tag" as const,
            tagQuery: query.substring(4).trim().replace(/^#/, ""),
          };
        } else if (query.startsWith("file:")) {
          const fileQuery = query.substring(5).trim();
          let fileRegex: RegExp | undefined;
          if (fileQuery.includes("*")) {
            const pattern = fileQuery.replace(/\./g, "\\.").replace(/\*/g, ".*");
            fileRegex = new RegExp(`^${pattern}$`, "i");
          }
          return {
            color: group.color,
            query,
            type: "file" as const,
            fileQuery,
            fileRegex,
          };
        } else {
          return {
            color: group.color,
            query,
            type: "text" as const,
          };
        }
      })
      .filter((g) => g.query !== "");
    this.groupsDirty = false;
  }

  private getNodeShape(node: GraphNode): NodeShape {
    switch (node.type) {
      case NodeType.Tag:
        return this.settings.tagShape;
      case NodeType.Attachment:
        return this.settings.attachmentShape;
      default:
        return this.settings.nodeShape;
    }
  }

  private getNodeSize(node: GraphNode): number {
    switch (node.type) {
      case NodeType.Tag:
        return this.settings.tagNodeSize;
      case NodeType.Attachment:
        return this.settings.attachmentNodeSize;
      default:
        return this.settings.nodeSize;
    }
  }

  private getNodeColor(node: GraphNode): string {
    const { useThemeColors, colorHighlight, colorNode, colorTag, colorAttachment } = this.settings;

    if (this.highlightedNodes.has(node.id)) {
      return useThemeColors
        ? this.getCssColor("--graph-node-focused", colorHighlight)
        : colorHighlight;
    }

    for (const group of this.preprocessedGroups) {
      const { query, type } = group;

      if (type === "path") {
        if (node.type !== NodeType.Tag && node.id.toLowerCase().startsWith(group.pathQuery!)) {
          return group.color;
        }
      } else if (type === "tag") {
        const tagQuery = group.tagQuery!;
        if (node.type === NodeType.Tag && node.name.toLowerCase() === `#${tagQuery}`) {
          return group.color;
        }
        if (
          node.type === NodeType.File &&
          node.tags?.some((tag) => tag.toLowerCase() === tagQuery)
        ) {
          return group.color;
        }
      } else if (type === "file") {
        if ((node.type === NodeType.File || node.type === NodeType.Attachment) && node.filename) {
          if (group.fileRegex) {
            if (group.fileRegex.test(node.filename)) {
              return group.color;
            }
          } else {
            if (node.filename.toLowerCase() === group.fileQuery!) {
              return group.color;
            }
          }
        }
      } else {
        let nodeContentLower = "";
        if (node.type === NodeType.File) {
          nodeContentLower = this.fileContentCache.get(node.id)?.lowerCaseContent || "";
        }
        if (node.name.toLowerCase().includes(query) || nodeContentLower.includes(query)) {
          return group.color;
        }
      }
    }

    if (useThemeColors) {
      if (node.type === NodeType.Tag) return this.getCssColor("--graph-tags", colorTag);
      if (node.type === NodeType.Attachment)
        return this.getCssColor("--graph-unresolved", colorAttachment);
      return this.getCssColor("--graph-node", colorNode);
    } else {
      if (node.type === NodeType.Tag) return colorTag;
      if (node.type === NodeType.Attachment) return colorAttachment;
      return colorNode;
    }
  }

  public updateDisplay() {
    if (!this.isGraphInitialized) return;
    this.updatePreprocessedGroups();
    this.updateColors();
  }

  public updateForces() {
    if (!this.isGraphInitialized) return;

    const { centerForce, repelForce, linkForce, useWasmPhysics } = this.settings;

    if (useWasmPhysics) {
      this.physicsBridge.setParams({
        gravity: centerForce,
        repulsion: repelForce * 40.0,
        attraction: linkForce,
      });
    } else {
      if (this.centerForce) {
        this.centerForce.strength(centerForce);
      }
      if (this.chargeForce) {
        this.chargeForce.strength(-repelForce);
      }
      if (this.linkForce) {
        this.linkForce.strength(linkForce);
      }
    }
  }

  public updateControls() {
    if (!this.isGraphInitialized) return;
    const { rotateSpeed, panSpeed, zoomSpeed } = this.settings;
    const controls = this.graph.controls();
    if (controls) {
      controls.rotateSpeed = rotateSpeed;
      controls.panSpeed = panSpeed;
      controls.zoomSpeed = zoomSpeed;
      if (!this.controlsListenerAdded) {
        let labelUpdatePending = false;
        controls.addEventListener("change", () => {
          if (!this.settings.showNodeLabels || this.settings.performanceMode) return;
          if (!labelUpdatePending) {
            labelUpdatePending = true;
            requestAnimationFrame(() => {
              this.updateLabels();
              labelUpdatePending = false;
            });
          }
        });
        this.controlsListenerAdded = true;
      }
    }
  }

  private updateLabels() {
    if (
      !this.isGraphInitialized ||
      !this.labelRenderer ||
      this.currentPositions.length === 0 ||
      !this.settings.showNodeLabels ||
      this.settings.performanceMode
    ) {
      if (this.labelRenderer?.instancedMesh) {
        this.labelRenderer.instancedMesh.visible = false;
      }
      return;
    }

    const camera = this.graph?.camera();
    if (!camera) return;

    this.labelRenderer.updateVisibilityAndOcclusion(
      camera,
      this.currentPositions,
      this.settings,
      this.hoveredNode ? this.hoveredNode.id : null,
      this.highlightedNodes,
    );
  }

  private handleNodeClick(node: GraphNode, event?: MouseEvent) {
    if (!node) return;

    if (event && (event.ctrlKey || event.metaKey)) {
      this.app.workspace.openLinkText(node.id, node.id, "tab");
      return;
    }

    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
      this.handleNodeDoubleClick(node);
    } else {
      this.clickTimeout = setTimeout(() => {
        this.handleNodeSingleClick(node);
        this.clickTimeout = null;
      }, this.CLICK_DELAY);
    }
  }

  private handleNodeDoubleClick(node: GraphNode) {
    if (node.type === NodeType.File || node.type === NodeType.Attachment) {
      const file = this.app.vault.getAbstractFileByPath(node.id);
      if (file instanceof TFile) this.app.workspace.getLeaf("tab").openFile(file);
    }
  }

  private handleNodeSingleClick(node: GraphNode) {
    if (this.selectedNode === node.id) {
      this.selectedNode = null;
      this.highlightedNodes.clear();
      this.highlightedLinks.clear();
    } else {
      this.selectedNode = node.id;
      this.highlightedNodes.clear();
      this.highlightedLinks.clear();
      this.highlightedNodes.add(node.id);

      const connectedLinks = this.linkAdjacencyIndex.get(node.id) || [];
      connectedLinks.forEach((link: ProcessedGraphLink) => {
        const sourceId =
          typeof link.source === "object" ? (link.source as GraphNode).id : (link.source as string);
        const targetId =
          typeof link.target === "object" ? (link.target as GraphNode).id : (link.target as string);

        this.highlightedNodes.add(sourceId);
        this.highlightedNodes.add(targetId);
        this.highlightedLinks.add(link);
      });

      if (this.settings.zoomOnClick) {
        const zoomDistance = 40;
        const idx = this.nodeIdToIndex.get(node.id);
        if (idx !== undefined && this.currentPositions.length > idx * 4) {
          this.reusableNodePosition.set(
            this.currentPositions[idx * 4],
            this.currentPositions[idx * 4 + 1],
            this.currentPositions[idx * 4 + 2],
          );
        } else {
          this.reusableNodePosition.set(node.x || 0, node.y || 0, node.z || 0);
        }
        const cameraPosition = this.graph.camera().position;
        this.reusableDirection.subVectors(cameraPosition, this.reusableNodePosition).normalize();
        this.reusableTargetPosition.addVectors(
          this.reusableNodePosition,
          this.reusableDirection.multiplyScalar(zoomDistance),
        );
        this.graph.cameraPosition(this.reusableTargetPosition, this.reusableNodePosition, 1000);
      }
    }
    this.updateNodeColorsDiff();
    this.updateLabels();
  }

  private handleNodeHover(node: GraphNode | null) {
    if (this.hoveredNode && this.hoveredNode !== node) {
      this.hoveredNode.fx = undefined;
      this.hoveredNode.fy = undefined;
      this.hoveredNode.fz = undefined;
    }

    this.hoveredNode = node;
    if (this.hoveredNode) {
      this.hoveredNode.fx = this.hoveredNode.x;
      this.hoveredNode.fy = this.hoveredNode.y;
      this.hoveredNode.fz = this.hoveredNode.z;
    }

    this.highlightedNodes.clear();
    this.highlightedLinks.clear();

    if (node) {
      this.highlightedNodes.add(node.id);
      const connectedLinks = this.linkAdjacencyIndex.get(node.id) || [];
      connectedLinks.forEach((link: ProcessedGraphLink) => {
        this.highlightedLinks.add(link);
      });
    }
    this.updateNodeColorsDiff();
    this.updateLabels();
  }

  private updateNodeColorsDiff() {
    const nodesToUpdate = new Set<string>();
    this.lastHighlightedNodes.forEach((id) => nodesToUpdate.add(id));
    this.highlightedNodes.forEach((id) => nodesToUpdate.add(id));

    if (this.instancedRenderer) {
      const colorMap = new Map<number, string>();
      nodesToUpdate.forEach((nodeId) => {
        const idx = this.nodeIdToIndex.get(nodeId);
        const node = this.nodeMap.get(nodeId);
        if (idx !== undefined && node) {
          colorMap.set(idx, this.getNodeColor(node));
        }
      });
      this.instancedRenderer.updateNodeColors(colorMap);

      const linkHighlightColor = this.settings.useThemeColors
        ? this.getCssColor("--graph-node-focused", this.settings.colorHighlight)
        : this.settings.colorHighlight;
      const linkColor = this.settings.useThemeColors
        ? this.getCssColor("--graph-line", this.settings.colorLink)
        : this.settings.colorLink;

      const highlightedEdgeIndices = new Set<number>();
      this.highlightedLinks.forEach((linkObj) => {
        const idx = this.linkToIndex.get(linkObj as GraphLink);
        if (idx !== undefined) highlightedEdgeIndices.add(idx);
      });
      this.instancedRenderer.updateEdgeColors(highlightedEdgeIndices, linkHighlightColor, linkColor);
    }

    if (this.labelRenderer && this.currentPositions.length > 0) {
      this.labelRenderer.updateVisibilityAndOcclusion(
        this.graph.camera(),
        this.currentPositions,
        this.settings,
        this.hoveredNode ? this.hoveredNode.id : null,
        this.highlightedNodes,
      );
    }

    this.lastHighlightedNodes.clear();
    this.highlightedNodes.forEach((id) => this.lastHighlightedNodes.add(id));
  }

  private getLinkCurvature(link: ProcessedGraphLink) {
    if (this.settings.performanceMode) return 0;
    const sourceId =
      typeof link.source === "object" ? (link.source as GraphNode).id : (link.source as string);
    const targetId =
      typeof link.target === "object" ? (link.target as GraphNode).id : (link.target as string);
    const key = `${sourceId}->${targetId}`;
    if (this.reciprocalLinks.has(key)) {
      return sourceId > targetId ? 0.2 : -0.2;
    }
    return 0;
  }

  private matchesFilter(node: GraphNode, filter: Filter): boolean {
    const filterValue = filter.value.trim().toLowerCase();
    if (!filterValue) return false;

    if (filter.type === "path") {
      return node.id.toLowerCase().includes(filterValue);
    }
    if (filter.type === "tag") {
      const tagToMatch = filterValue.startsWith("#") ? filterValue.substring(1) : filterValue;
      if (node.type === NodeType.Tag) {
        return node.name.toLowerCase() === `#${tagToMatch}`;
      }
      return node.tags?.some((tag) => tag.toLowerCase() === tagToMatch) ?? false;
    }
    return false;
  }

  private async processVaultData(): Promise<{
    nodes: GraphNode[];
    links: { source: string; target: string }[];
  } | null> {
    const { showAttachments, hideOrphans, showTags, searchQuery, showNeighboringNodes, filters } =
      this.settings;
    const allFiles = this.app.vault.getFiles();
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    if (!resolvedLinks) return null;

    const allNodesMap = new Map<string, GraphNode>();

    const allFilePaths = new Set(allFiles.map((f) => f.path));
    for (const path of this.processedNodes.keys()) {
      if (!allFilePaths.has(path)) {
        this.processedNodes.delete(path);
      }
    }
    for (const path of this.fileContentCache.keys()) {
      if (!allFilePaths.has(path)) {
        this.fileContentCache.delete(path);
      }
    }

    const needsContent =
      !!searchQuery ||
      this.preprocessedGroups.some((g) => {
        return g.type === "text";
      });

    const CONCURRENCY_LIMIT = 50;
    const readQueue = [...allFiles];
    const workers = Array(Math.min(CONCURRENCY_LIMIT, readQueue.length))
      .fill(null)
      .map(async () => {
        while (readQueue.length > 0) {
          const file = readQueue.shift()!;
          const cachedNodeInfo = this.processedNodes.get(file.path);

          let node: GraphNode;

          if (cachedNodeInfo && cachedNodeInfo.mtime === file.stat.mtime) {
            node = cachedNodeInfo.node;
            if (
              node.type === NodeType.File &&
              needsContent &&
              !this.fileContentCache.has(file.path)
            ) {
              const content = await this.app.vault.cachedRead(file);
              const lowerCaseContent = content.toLowerCase();
              this.fileContentCache.set(file.path, {
                mtime: file.stat.mtime,
                content,
                lowerCaseContent,
              });
            }
          } else {
            const cache = this.app.metadataCache.getFileCache(file);
            const tags = cache
              ? (getAllTags(cache) || []).map((t) => (t.startsWith("#") ? t.substring(1) : t))
              : [];
            const type = file.extension === "md" ? NodeType.File : NodeType.Attachment;

            if (type === NodeType.File && needsContent) {
              const cachedContent = this.fileContentCache.get(file.path);
              if (!cachedContent || cachedContent.mtime !== file.stat.mtime) {
                const content = await this.app.vault.cachedRead(file);
                const lowerCaseContent = content.toLowerCase();
                this.fileContentCache.set(file.path, {
                  mtime: file.stat.mtime,
                  content,
                  lowerCaseContent,
                });
              }
            }

            node = {
              id: file.path,
              name: file.basename,
              filename: file.name,
              type,
              tags,
            };
            this.processedNodes.set(file.path, {
              node,
              mtime: file.stat.mtime,
            });
          }

          allNodesMap.set(file.path, node);
        }
      });
    await Promise.all(workers);

    const allLinks: { source: string; target: string }[] = [];
    const existingLinks = new Set<string>();
    const adjacency = new Map<string, string[]>();

    const addLink = (source: string, target: string) => {
      const linkKey = `${source}->${target}`;
      if (!existingLinks.has(linkKey)) {
        existingLinks.add(linkKey);
        allLinks.push({ source, target });

        let srcAdj = adjacency.get(source);
        if (!srcAdj) {
          srcAdj = [];
          adjacency.set(source, srcAdj);
        }
        srcAdj.push(target);

        let tgtAdj = adjacency.get(target);
        if (!tgtAdj) {
          tgtAdj = [];
          adjacency.set(target, tgtAdj);
        }
        tgtAdj.push(source);
      }
    };

    for (const sourcePath in resolvedLinks) {
      const targets = resolvedLinks[sourcePath];
      for (const targetPath in targets) {
        addLink(sourcePath, targetPath);
      }
    }

    for (const file of allFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatterLinks) {
        for (const linkCache of cache.frontmatterLinks) {
          const destFile = this.app.metadataCache.getFirstLinkpathDest(linkCache.link, file.path);
          if (destFile) {
            addLink(file.path, destFile.path);
          }
        }
      }
    }

    if (showTags) {
      allNodesMap.forEach((node) => {
        if (node.type === NodeType.File && node.tags) {
          for (let i = 0; i < node.tags.length; i++) {
            const tagName = node.tags[i];
            const tagId = `tag:${tagName}`;
            if (!allNodesMap.has(tagId)) {
              allNodesMap.set(tagId, {
                id: tagId,
                name: `#${tagName}`,
                type: NodeType.Tag,
              });
            }
            addLink(node.id, tagId);
          }
        }
      });
    }

    const allNodes = Array.from(allNodesMap.values());
    const activeFilters = filters.filter((f) => f.enabled && f.value.trim() !== "");
    const hasActiveFilters = activeFilters.length > 0;
    const lowerCaseSearch = searchQuery ? searchQuery.toLowerCase() : "";

    const isNodeMatch = (node: GraphNode): boolean => {
      if (hasActiveFilters) {
        let filterPassed = false;
        for (let i = 0; i < activeFilters.length; i++) {
          if (this.matchesFilter(node, activeFilters[i])) {
            filterPassed = true;
            break;
          }
        }
        if (!filterPassed) return false;
      }

      if (lowerCaseSearch) {
        let nodeContentLower = "";
        if (node.type === NodeType.File) {
          nodeContentLower = this.fileContentCache.get(node.id)?.lowerCaseContent || "";
        }
        const matches =
          node.name.toLowerCase().includes(lowerCaseSearch) ||
          (node.type !== NodeType.Tag && node.id.toLowerCase().includes(lowerCaseSearch)) ||
          nodeContentLower.includes(lowerCaseSearch);
        if (!matches) return false;
      }

      return true;
    };

    const isTypeVisible = (node: GraphNode): boolean => {
      if (node.type === NodeType.Tag) return showTags;
      if (node.type === NodeType.Attachment) return showAttachments;
      return true;
    };

    const hasFilterOrSearch = hasActiveFilters || Boolean(lowerCaseSearch);
    const visibleNodeIds = new Set<string>();

    if (hasFilterOrSearch) {
      const matchedNodeIds: string[] = [];
      for (let i = 0; i < allNodes.length; i++) {
        const node = allNodes[i];
        if (isNodeMatch(node)) {
          matchedNodeIds.push(node.id);
          if (isTypeVisible(node)) {
            visibleNodeIds.add(node.id);
          }
        }
      }

      if (showNeighboringNodes) {
        for (let i = 0; i < matchedNodeIds.length; i++) {
          const neighbors = adjacency.get(matchedNodeIds[i]);
          if (neighbors) {
            for (let j = 0; j < neighbors.length; j++) {
              const neighborId = neighbors[j];
              const neighborNode = allNodesMap.get(neighborId);
              if (neighborNode && isTypeVisible(neighborNode)) {
                visibleNodeIds.add(neighborId);
              }
            }
          }
        }
      }
    } else {
      for (let i = 0; i < allNodes.length; i++) {
        const node = allNodes[i];
        if (isTypeVisible(node)) {
          visibleNodeIds.add(node.id);
        }
      }
    }

    const linksToShow: { source: string; target: string }[] = [];
    const connectedNodeIds = hideOrphans ? new Set<string>() : null;

    for (let i = 0; i < allLinks.length; i++) {
      const link = allLinks[i];
      if (visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)) {
        linksToShow.push(link);
        if (connectedNodeIds) {
          connectedNodeIds.add(link.source);
          connectedNodeIds.add(link.target);
        }
      }
    }

    const nodesToShow: GraphNode[] = [];
    for (const nodeId of visibleNodeIds) {
      if (!connectedNodeIds || connectedNodeIds.has(nodeId)) {
        const node = allNodesMap.get(nodeId);
        if (node) nodesToShow.push(node);
      }
    }

    return { nodes: nodesToShow, links: linksToShow };
  }

  private cleanupNode(
    node: GraphNode,
    options: { cleanMesh?: boolean; cleanGroup?: boolean } = {
      cleanMesh: true,
      cleanGroup: true,
    },
  ) {
    if (options.cleanMesh) {
      this.nodeMeshes.delete(node);
    }

    if (options.cleanGroup && node.__threeObj) {
      node.__threeObj.parent?.remove(node.__threeObj);
    }
  }

  async onClose() {
    this.stopIdleRotation();
    this.physicsBridge.dispose();
    if (this.clickTimeout) clearTimeout(this.clickTimeout);
    this.resizeObserver?.disconnect();
    if (this.graph) {
      this.graph.graphData().nodes.forEach((node: GraphNode) => this.cleanupNode(node));
      this.isGraphInitialized = false;
      this.graph.pauseAnimation();
      const renderer = this.graph.renderer();
      if (renderer?.domElement) {
        renderer.forceContextLoss();
        renderer.dispose();
      }
      if (typeof this.graph._destructor === "function") {
        this.graph._destructor();
      }
      this.graph = null;
    }
    if (this.instancedRenderer) {
      this.instancedRenderer.clear();
      this.instancedRenderer = null;
    }
    if (this.labelRenderer) {
      this.labelRenderer.clear();
      this.labelRenderer = null;
    }
    if (this.messageEl) {
      this.messageEl.remove();
    }
    if (this.counterEl) {
      this.counterEl.remove();
    }
    this.clearResourceCaches();
    if (this.colorResolverEl) {
      this.colorResolverEl.remove();
      this.colorResolverEl = null;
    }
    this.colorCanvasCtx = null;
    this.colorCache.clear();
    this.processedNodes.clear();
    this.nodeMap.clear();
    this.reciprocalLinks.clear();
    this.linkAdjacencyIndex.clear();
    this.lastHighlightedNodes.clear();
    this.controlsListenerAdded = false;
  }
}
