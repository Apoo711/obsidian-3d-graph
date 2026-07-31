import { ItemView, WorkspaceLeaf, TFile, Setting, setIcon, debounce, getAllTags } from 'obsidian';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import SpriteText from 'three-spritetext';
import Graph3DPlugin from '../main';
import { Graph3DPluginSettings, GraphNode, GraphLink, NodeShape, NodeType, Filter, ColorGroup } from './types';
import { PhysicsBridge } from './physics/physics-bridge';
import { getWasmArrayBuffer, createWorkerBlobUrl } from './physics/wasm-loader';

export const VIEW_TYPE_3D_GRAPH = "3d-graph-view";

interface ProcessedGraphLink {
	source: GraphNode;
	target: GraphNode;
}

interface PreprocessedGroup {
	color: string;
	query: string;
	type: 'path' | 'tag' | 'file' | 'text';
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

	private reusableNodePosition = new THREE.Vector3();
	private reusableDirection = new THREE.Vector3();
	private cachedOccluders: THREE.Mesh[] = [];
	private occludersCacheDirty = true;
	private readonly RAYCAST_CULL_DISTANCE = 800;

	private nodeMeshes = new WeakMap<GraphNode, THREE.Mesh>();
	private nodeSprites = new Map<GraphNode, SpriteText>();

	private highlightedNodes = new Set<string>();
	private highlightedLinks = new Set<object>();
	private selectedNode: string | null = null;
	private hoveredNode: GraphNode | null = null;

	private colorCache = new Map<string, string>();

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

	// Keyboard controls state
	private pressedKeys = new Set<string>();

	private fileContentCache = new Map<string, { mtime: number, content: string, lowerCaseContent: string }>();
	private processedNodes = new Map<string, { node: GraphNode, mtime: number }>();
	private nodeMap = new Map<string, GraphNode>();
	private reciprocalLinks = new Set<string>();
	private linkAdjacencyIndex = new Map<string, ProcessedGraphLink[]>();
	private lastHighlightedNodes = new Set<string>();
	private preprocessedGroups: PreprocessedGroup[] = [];
	private groupsDirty = true;

	// Reusable Vector3 variables to avoid GC pressure in keyboard handler
	private keyboardDirection = new THREE.Vector3();
	private keyboardRight = new THREE.Vector3();
	private keyboardMoveVector = new THREE.Vector3();
	private keyboardNewPos = new THREE.Vector3();
	private keyboardNewTarget = new THREE.Vector3();

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
				case NodeShape.Cube: geometry = new THREE.BoxGeometry(1, 1, 1); break;
				case NodeShape.Pyramid: geometry = new THREE.ConeGeometry(1 / 1.5, 1, perf ? 3 : 4); break;
				case NodeShape.Tetrahedron: geometry = new THREE.TetrahedronGeometry(1 / 1.2); break;
				default: geometry = new THREE.SphereGeometry(0.5, perf ? 8 : 16, perf ? 6 : 12);
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
				opacity: 0.9
			});
			this.materialCache.set(color, material);
		}
		return material;
	}

	public clearResourceCaches() {
		this.geometryCache.forEach(g => g.dispose());
		this.geometryCache.clear();
		this.materialCache.forEach(m => m.dispose());
		this.materialCache.clear();
	}

	getViewType() { return VIEW_TYPE_3D_GRAPH; }
	getDisplayText() { return "3d graph"; }

	async onOpen() {
		const rootContainer = this.contentEl;
		rootContainer.empty();
		rootContainer.addClass('graph-3d-view-content');

		const viewWrapper = rootContainer.createEl('div', { cls: 'graph-3d-view-wrapper' });

		this.graphContainer = viewWrapper.createEl('div', { cls: 'graph-3d-container', attr: { tabindex: '0' } }); // Make it focusable
		this.messageEl = viewWrapper.createEl('div', { cls: 'graph-3d-message' });
		this.counterEl = viewWrapper.createEl('div', { cls: 'graph-3d-counter' });

		this.addLocalControls();
		this.initializeGraph();

		const debouncedResize = debounce(() => {
			if (this.graph && this.isGraphInitialized) {
				this.graph.width(this.graphContainer.offsetWidth);
				this.graph.height(this.graphContainer.offsetHeight);
			}
		}, 150, false);

		this.resizeObserver = new ResizeObserver(() => debouncedResize());
		this.resizeObserver.observe(this.graphContainer);

		// Scoped event listeners
		this.registerDomEvent(this.graphContainer, 'keydown', this.handleKeyDown.bind(this));
		this.registerDomEvent(this.graphContainer, 'keyup', this.handleKeyUp.bind(this));

		this.registerEvent(this.app.workspace.on('css-change', () => {
			this.colorCache.clear();
			if (this.isGraphInitialized) {
				this.updateColors();
			}
		}));
	}

	private addLocalControls() {
		const controlsContainer = this.contentEl.createEl('div', { cls: 'graph-3d-controls-container' });

		// Add Reset View button
		const resetViewButton = controlsContainer.createEl('div', { cls: 'graph-3d-reset-toggle' });
		setIcon(resetViewButton, 'refresh-cw');
		resetViewButton.setAttribute('aria-label', 'Reset view');
		resetViewButton.addEventListener('click', () => {
			if (this.graph && this.isGraphInitialized) {
				this.graph.zoomToFit(800);
			}
		});

		this.settingsToggleButton = controlsContainer.createEl('div', { cls: 'graph-3d-settings-toggle' });
		setIcon(this.settingsToggleButton, 'settings');
		this.settingsToggleButton.setAttribute('aria-label', 'Graph settings');
		this.settingsPanel = controlsContainer.createEl('div', { cls: 'graph-3d-settings-panel' });
		this.settingsToggleButton.addEventListener('click', () => {
			this.settingsPanel.classList.toggle('is-open');
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
		return this.settingsPanel?.classList.contains('is-open');
	}

	private renderSearchSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Search');
		new Setting(container)
			.setName('Search term')
			.addText(text => text
				.setValue(this.settings.searchQuery)
				.onChange(debounce(async (value) => {
					this.settings.searchQuery = value.trim();
					await this.plugin.saveSettings();
					this.updateData({ useCache: true, reheat: false });
				}, 500, true)));
		new Setting(container)
			.setName('Show neighboring nodes')
			.setDesc('Show nodes linked to search/filter results.')
			.addToggle(toggle => toggle
				.setValue(this.settings.showNeighboringNodes)
				.onChange(async (value) => {
					this.settings.showNeighboringNodes = value;
					await this.plugin.saveSettings();
					this.updateData({ useCache: true, reheat: false });
				}));
	}

	private renderAdvancedFilters(container: HTMLElement) {
		new Setting(container).setHeading().setName('Advanced Filters');

		this.settings.filters.forEach((filter, index) => {
			const setting = new Setting(container)
				.addDropdown(dropdown => dropdown
					.addOption('path', 'Path')
					.addOption('tag', 'Tag')
					.onChange(async (value: string) => {
						filter.type = value as 'path' | 'tag';
						await this.plugin.saveSettings();
						this.updateData({ useCache: true });
					}))
				.addText(text => text
					.setPlaceholder('Enter filter value...')
					.setValue(filter.value)
					.onChange(debounce(async (value) => {
						filter.value = value;
						await this.plugin.saveSettings();
						this.updateData({ useCache: true });
					}, 500, true)))
				.addToggle(toggle => {
					toggle.setTooltip("Enable/Disable filter")
						.setValue(filter.enabled)
						.onChange(async (value) => {
							filter.enabled = value;
							await this.plugin.saveSettings();
							this.updateData({ useCache: true });
						});
				})
				.addExtraButton(button => button
					.setIcon('cross')
					.setTooltip('Remove filter')
					.onClick(async () => {
						this.settings.filters.splice(index, 1);
						await this.plugin.saveSettings();
						this.renderSettingsPanel();
						this.updateData({ useCache: true });
					}));
		});

		new Setting(container)
			.addButton(button => button
				.setButtonText('Add new filter')
				.onClick(async () => {
					this.settings.filters.push({ type: 'path', value: '', enabled: true });
					await this.plugin.saveSettings();
					this.renderSettingsPanel();
				}));
	}

	private renderFilterSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('General Filters');

		new Setting(container).setName('Show tags').addToggle(toggle => toggle
			.setValue(this.settings.showTags)
			.onChange(async (value) => {
				this.settings.showTags = value;
				await this.plugin.saveSettings();
				this.updateData({ useCache: true, reheat: false });
			}));

		new Setting(container).setName('Show attachments').addToggle(toggle => toggle
			.setValue(this.settings.showAttachments)
			.onChange(async (value) => {
				this.settings.showAttachments = value;
				await this.plugin.saveSettings();
				this.updateData({ useCache: true, reheat: false });
			}));

		new Setting(container).setName('Hide orphans').addToggle(toggle => toggle
			.setValue(this.settings.hideOrphans)
			.onChange(async (value) => {
				this.settings.hideOrphans = value;
				await this.plugin.saveSettings();
				this.updateData({ useCache: true, reheat: false });
			}));
	}

	private renderGroupSettings(container: HTMLElement) {
		const groupContainer = container.createDiv();
		const render = () => {
			groupContainer.empty();
			new Setting(groupContainer).setHeading().setName('Color Groups');

			this.settings.groups.forEach((group, index) => {
				new Setting(groupContainer)
					.addText(text => text
						.setPlaceholder('path:, tag:, file:, or text')
						.setValue(group.query)
						.onChange(async (value) => {
							group.query = value;
							await this.plugin.saveSettings();
							this.updateColors();
						}))
					.addColorPicker(color => color
						.setValue(group.color)
						.onChange(async (value) => {
							group.color = value;
							await this.plugin.saveSettings();
							this.updateColors();
						}))
					.addExtraButton(button => button
						.setIcon('cross')
						.setTooltip('Remove group')
						.onClick(async () => {
							this.settings.groups.splice(index, 1);
							await this.plugin.saveSettings();
							render();
							this.updateColors();
						}));
			});

			new Setting(groupContainer)
				.addButton(button => button
					.setButtonText('Add new group')
					.onClick(async () => {
						this.settings.groups.push({ query: '', color: '#ffffff' });
						await this.plugin.saveSettings();
						render();
					}));
		};
		render();
	}

	private renderAppearanceSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Appearance');

		new Setting(container)
			.setName('Performance Mode')
			.setDesc('Lowers geometry detail, disables link curvature and labels for better performance.')
			.addToggle(toggle => toggle
				.setValue(this.settings.performanceMode)
				.onChange(async (value) => {
					this.settings.performanceMode = value;
					this.clearResourceCaches();
					await this.plugin.saveSettings();
					this.updateDisplay();
					if (value) {
						this.graph.graphData().nodes.forEach((node: GraphNode) => this.removeNodeSprite(node));
					} else {
						this.updateLabels();
					}
				}));

		const updateDisplayAndColors = async () => {
			await this.plugin.saveSettings();
			this.updateDisplay();
		}

		new Setting(container).setName('Node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.nodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.settings.nodeSize = v; await updateDisplayAndColors(); }));
		new Setting(container).setName('Tag node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.tagNodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.settings.tagNodeSize = v; await updateDisplayAndColors(); }));
		new Setting(container).setName('Attachment node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.attachmentNodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.settings.attachmentNodeSize = v; await updateDisplayAndColors(); }));
		new Setting(container).setName('Link thickness').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.linkThickness).setDynamicTooltip()
			.onChange(async (v) => { this.settings.linkThickness = v; await updateDisplayAndColors(); }));

		new Setting(container).setName('Node shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.settings.nodeShape)
			.onChange(async(value: string) => {this.settings.nodeShape = value as NodeShape; await updateDisplayAndColors()}));
		new Setting(container).setName('Tag shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.settings.tagShape)
			.onChange(async(value: string) => {this.settings.tagShape = value as NodeShape; await updateDisplayAndColors()}));
		new Setting(container).setName('Attachment shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.settings.attachmentShape)
			.onChange(async(value: string) => {this.settings.attachmentShape = value as NodeShape; await updateDisplayAndColors()}));
	}

	private renderLabelSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Labels');

		new Setting(container)
			.setName('Show node labels')
			.setDesc('If you enable this, please reopen the graph view to see the labels.')
			.addToggle(toggle => toggle.setValue(this.settings.showNodeLabels)
				.onChange(async (value) => {
					this.settings.showNodeLabels = value;
					await this.plugin.saveSettings();

					if (!value) {
						this.graph.graphData().nodes.forEach((node: GraphNode) => this.cleanupNode(node, { cleanMesh: false, cleanGroup: false }));
					}
					this.updateDisplay();
				}));

		new Setting(container)
			.setName('Show labels on hover/highlight only')
			.addToggle(toggle => toggle.setValue(this.settings.showLabelsOnHoverOnly)
				.onChange(async (value) => {
					this.settings.showLabelsOnHoverOnly = value;
					await this.plugin.saveSettings();
					this.updateDisplay();
				}));

		new Setting(container)
			.setName('Label distance')
			.addSlider(s => s.setLimits(50, 500, 10).setValue(this.settings.labelDistance).setDynamicTooltip()
				.onChange(async (v) => {
					this.settings.labelDistance = v;
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName('Prevent label occlusion')
			.setDesc('Can impact performance on large graphs.')
			.addToggle(toggle => toggle.setValue(this.settings.labelOcclusion)
				.onChange(async (value) => {
					this.settings.labelOcclusion = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderInteractionSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Interaction');

		new Setting(container).setName("Use Keyboard Controls (WASD)")
			.addToggle(toggle => toggle.setValue(this.settings.useKeyboardControls)
				.onChange(async (value) => { this.settings.useKeyboardControls = value; await this.plugin.saveSettings(); this.updateControls() }));

		new Setting(container).setName('Keyboard move speed').addSlider(s => s.setLimits(0.1, 10, 0.1).setValue(this.settings.keyboardMoveSpeed).setDynamicTooltip()
			.onChange(async (v) => { this.settings.keyboardMoveSpeed = v; await this.plugin.saveSettings(); }));

		new Setting(container).setName("Zoom on click")
			.addToggle(toggle => toggle.setValue(this.settings.zoomOnClick)
				.onChange(async (value) => {
					this.settings.zoomOnClick = value;
					await this.plugin.saveSettings();
				}));

		new Setting(container).setName('Rotation speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.rotateSpeed).setDynamicTooltip()
			.onChange(async (v) => {
				this.settings.rotateSpeed = v;
				await this.plugin.saveSettings();
				this.updateControls();
			}));

		new Setting(container).setName('Pan speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.panSpeed).setDynamicTooltip()
			.onChange(async (v) => {
				this.settings.panSpeed = v;
				await this.plugin.saveSettings();
				this.updateControls();
			}));

		new Setting(container).setName('Zoom speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.zoomSpeed).setDynamicTooltip()
			.onChange(async (v) => {
				this.settings.zoomSpeed = v;
				await this.plugin.saveSettings();
				this.updateControls();
			}));
	}

	private renderForceSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Forces');

		const forceChangeHandler = async () => {
			await this.plugin.saveSettings();
			this.updateData({ useCache: false, reheat: true });
		};

		new Setting(container)
			.setName('Center force')
			.addSlider(slider => slider
				.setLimits(0, 1, 0.01)
				.setValue(this.settings.centerForce)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.settings.centerForce = value;
					await forceChangeHandler();
				}));

		new Setting(container)
			.setName('Repel force')
			.addSlider(slider => slider
				.setLimits(0, 20, 0.1)
				.setValue(this.settings.repelForce)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.settings.repelForce = value;
					await forceChangeHandler();
				}));

		new Setting(container)
			.setName('Use Rust WASM Physics Engine')
			.setDesc('High-performance 128-bit SIMD force engine running in a Web Worker for multi-thousand node scaling.')
			.addToggle(toggle => toggle
				.setValue(this.settings.useWasmPhysics)
				.onChange(async (value) => {
					this.settings.useWasmPhysics = value;
					await forceChangeHandler();
				}));
	}

	private initializeForces() {
		this.chargeForce = this.graph.d3Force('charge');
		this.centerForce = this.graph.d3Force('center');
		this.linkForce = this.graph.d3Force('link');
	}

	private handleKeyDown(event: KeyboardEvent) {
		const movementKeys = ['w', 'a', 's', 'd', 'q', 'e'];
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

		if (this.pressedKeys.has('w')) this.keyboardMoveVector.add(this.keyboardDirection);
		if (this.pressedKeys.has('s')) this.keyboardMoveVector.sub(this.keyboardDirection);
		if (this.pressedKeys.has('a')) this.keyboardMoveVector.sub(this.keyboardRight);
		if (this.pressedKeys.has('d')) this.keyboardMoveVector.add(this.keyboardRight);

		if (this.keyboardMoveVector.lengthSq() > 0) {
			this.keyboardMoveVector.normalize().multiplyScalar(moveSpeed);
			this.keyboardNewPos.copy(camera.position).add(this.keyboardMoveVector);
			this.keyboardNewTarget.copy(controls.target).add(this.keyboardMoveVector);
			this.graph.cameraPosition(this.keyboardNewPos, this.keyboardNewTarget);
		}

		if (this.pressedKeys.has('e')) {
			this.keyboardNewPos.copy(camera.position);
			this.keyboardNewPos.y += moveSpeed;
			this.keyboardNewTarget.copy(controls.target);
			this.keyboardNewTarget.y += moveSpeed;
			this.graph.cameraPosition(this.keyboardNewPos, this.keyboardNewTarget);
		}
		if (this.pressedKeys.has('q')) {
			this.keyboardNewPos.copy(camera.position);
			this.keyboardNewPos.y -= moveSpeed;
			this.keyboardNewTarget.copy(controls.target);
			this.keyboardNewTarget.y -= moveSpeed;
			this.graph.cameraPosition(this.keyboardNewPos, this.keyboardNewTarget);
		}
	}

	initializeGraph() {
		this.app.workspace.onLayoutReady(async () => {
			if (!this.graphContainer) return;

			const Graph = (ForceGraph3D as any).default || ForceGraph3D;
			this.graph = Graph()(this.graphContainer)
				.onNodeDrag((node: GraphNode) => {
					const controls = this.graph.controls();
					if (controls) {
						controls.enabled = false;
					}
					if (this.settings.useWasmPhysics && this.graph) {
						const nodes = this.graph.graphData().nodes as GraphNode[];
						const flatPositions = new Float32Array(nodes.length * 3);
						for (let i = 0; i < nodes.length; i++) {
							flatPositions[i * 3] = nodes[i].x || 0;
							flatPositions[i * 3 + 1] = nodes[i].y || 0;
							flatPositions[i * 3 + 2] = nodes[i].z || 0;
						}
						this.physicsBridge.setPositions(flatPositions);
					}
				})
				.onNodeDragEnd((node: GraphNode) => {
					const controls = this.graph.controls();
					if (controls) {
						controls.enabled = true;
					}
					if (this.settings.useWasmPhysics && this.graph) {
						const nodes = this.graph.graphData().nodes as GraphNode[];
						const flatPositions = new Float32Array(nodes.length * 3);
						for (let i = 0; i < nodes.length; i++) {
							flatPositions[i * 3] = nodes[i].x || 0;
							flatPositions[i * 3 + 1] = nodes[i].y || 0;
							flatPositions[i * 3 + 2] = nodes[i].z || 0;
						}
						this.physicsBridge.setPositions(flatPositions);
					}
				})
				.onNodeClick((node: GraphNode, event: MouseEvent) => this.handleNodeClick(node, event))
				.onNodeHover((node: GraphNode | null) => this.handleNodeHover(node))
				.linkCurvature((link: ProcessedGraphLink) => this.getLinkCurvature(link))
				.onEngineTick(() => {
					const now = performance.now();
					if (now - this.lastLabelUpdateTime > this.LABEL_UPDATE_INTERVAL) {
						this.lastLabelUpdateTime = now;
						this.updateLabels();
					}
					this.handleKeyboardMovement();
				});

			this.graph.graphData({ nodes: [], links: [] });

			this.initializeForces();
			this.graph.pauseAnimation();
			this.isGraphInitialized = true;

			setTimeout(() => { this.updateData({ isFirstLoad: true }); }, 100);
		});
	}

	public async updateData(options: { useCache?: boolean; reheat?: boolean; isFirstLoad?: boolean } = {}) {
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
						nodePositions.set(node.id, { x: node.x, y: node.y, z: node.z });
					}
				});
			}

			const newData = await this.processVaultData();
			const hasNodes = newData && newData.nodes.length > 0;

			const oldNodes = this.graph.graphData().nodes as GraphNode[];
			if (oldNodes.length > 0) {
				const newNodeIds = new Set(hasNodes ? newData.nodes.map(n => n.id) : []);
				const nodesToRemove = oldNodes.filter(node => !newNodeIds.has(node.id));
				nodesToRemove.forEach(node => this.cleanupNode(node));
			}

			if (hasNodes) {
				if (useCache) {
					const adjacencyMap: Map<string, string[]> = new Map();
					newData.links.forEach(link => {
						const sourceId = link.source as string;
						const targetId = link.target as string;

						if (!adjacencyMap.has(sourceId)) adjacencyMap.set(sourceId, []);
						if (!adjacencyMap.has(targetId)) adjacencyMap.set(targetId, []);

						adjacencyMap.get(sourceId)!.push(targetId);
						adjacencyMap.get(targetId)!.push(sourceId);
					});

					newData.nodes.forEach(node => {
						const cachedPos = nodePositions.get(node.id);
						if (cachedPos) {
							node.x = cachedPos.x;
							node.y = cachedPos.y;
							node.z = cachedPos.z;
						} else {
							const neighbors = adjacencyMap.get(node.id) || [];
							let connectedNodePos: {x:number, y:number, z:number} | undefined;

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
				this.messageEl.removeClass('is-visible');

				// Pre-compute reciprocal links for curvature O(1) checks
				this.reciprocalLinks.clear();
				const linkKeys = new Set<string>();
				newData.links.forEach(link => {
					linkKeys.add(`${link.source}->${link.target}`);
				});
				newData.links.forEach(link => {
					const reciprocalKey = `${link.target}->${link.source}`;
					if (linkKeys.has(reciprocalKey)) {
						this.reciprocalLinks.add(`${link.source}->${link.target}`);
					}
				});

				// Build node map for O(1) lookup
				this.nodeMap.clear();
				newData.nodes.forEach(node => {
					this.nodeMap.set(node.id, node);
				});

				this.graph.graphData(newData);
				this.occludersCacheDirty = true;

				// Build link adjacency index
				this.linkAdjacencyIndex.clear();
				const processedLinks = this.graph.graphData().links as ProcessedGraphLink[];
				processedLinks.forEach(link => {
					const sourceId = typeof link.source === 'object' ? (link.source as GraphNode).id : (link.source as string);
					const targetId = typeof link.target === 'object' ? (link.target as GraphNode).id : (link.target as string);

					if (!this.linkAdjacencyIndex.has(sourceId)) {
						this.linkAdjacencyIndex.set(sourceId, []);
					}
					if (!this.linkAdjacencyIndex.has(targetId)) {
						this.linkAdjacencyIndex.set(targetId, []);
					}
					this.linkAdjacencyIndex.get(sourceId)!.push(link);
					this.linkAdjacencyIndex.get(targetId)!.push(link);
				});

				this.updateForces();
				this.updateDisplay();
				this.updateColors();
				this.updateControls();

				if (this.counterEl) {
					this.counterEl.setText(`${newData.nodes.length} nodes · ${newData.links.length} links`);
					this.counterEl.addClass('is-visible');
				}

				if (this.settings.useWasmPhysics && hasNodes) {
					this.graph.d3AlphaDecay(1); // Stop main-thread D3 physics engine from spinning

					const nodeIndexMap = new Map<string, number>();
					newData.nodes.forEach((n: GraphNode, idx: number) => nodeIndexMap.set(n.id, idx));

					const edgesList: number[] = [];
					newData.links.forEach((l: GraphLink) => {
						const srcId = typeof l.source === 'object' ? (l.source as GraphNode).id : (l.source as string);
						const tgtId = typeof l.target === 'object' ? (l.target as GraphNode).id : (l.target as string);
						const srcIdx = nodeIndexMap.get(srcId);
						const tgtIdx = nodeIndexMap.get(tgtId);
						if (srcIdx !== undefined && tgtIdx !== undefined) {
							edgesList.push(srcIdx, tgtIdx);
						}
					});

					this.physicsBridge.init(
						getWasmArrayBuffer(),
						createWorkerBlobUrl(),
						newData.nodes.length,
						new Uint32Array(edgesList),
						{
							gravity: this.settings.centerForce,
							repulsion: this.settings.repelForce * 40.0,
							attraction: this.settings.linkForce,
						}
					).then(() => {
						this.physicsBridge.onTick((positions) => {
							for (let i = 0; i < newData.nodes.length; i++) {
								const node = newData.nodes[i];
								node.x = positions[i * 3];
								node.y = positions[i * 3 + 1];
								node.z = positions[i * 3 + 2];
								if (node.__threeObj) {
									node.__threeObj.position.set(node.x, node.y, node.z);
								}
							}
							this.handleKeyboardMovement();
						});
						this.physicsBridge.start();
					}).catch(err => {
						console.error("[3D Graph] WASM Physics engine failed to start, falling back to D3 force engine:", err);
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
				this.colorCache.clear();
				const bgColor = this.settings.useThemeColors
					? this.getCssColor('--background-primary', '#000000')
					: this.settings.backgroundColor;
				this.graph.backgroundColor(bgColor);
				this.messageEl.setText("No search results or filters matched.");
				this.messageEl.addClass('is-visible');
				if (this.counterEl) {
					this.counterEl.setText('');
					this.counterEl.removeClass('is-visible');
				}
				this.graph.pauseAnimation();
			}
		} catch (error) {
			console.error('3D Graph: An error occurred during updateData:', error);
		} finally {
			this.isUpdating = false;
		}
	}

	public updateColors() {
		if (!this.isGraphInitialized) return;

		this.updatePreprocessedGroups();

		const bgColor = this.settings.useThemeColors ? this.getCssColor('--background-primary', '#000000') : this.settings.backgroundColor;
		this.graph.backgroundColor(bgColor);

		this.graph.graphData().nodes.forEach((node: GraphNode) => {
			const mesh = this.nodeMeshes.get(node);
			if (mesh) {
				const color = this.getNodeColor(node);
				if (color) {
					mesh.material = this.getSharedMaterial(color);
				}
			}
		});

		const linkHighlightColor = this.settings.useThemeColors ? this.getCssColor('--graph-node-focused', this.settings.colorHighlight) : this.settings.colorHighlight;
		const linkColor = this.settings.useThemeColors ? this.getCssColor('--graph-line', this.settings.colorLink) : this.settings.colorLink;
		this.graph.linkColor((link: GraphLink) => this.highlightedLinks.has(link) ? linkHighlightColor : linkColor);
	}

	private getCssColor(variable: string, fallback: string): string {
		if (this.colorCache.has(variable)) {
			return this.colorCache.get(variable)!;
		}

		try {
			const tempEl = document.createElement('div');
			tempEl.style.display = 'none';
			tempEl.style.color = `var(${variable})`;
			document.body.appendChild(tempEl);

			const computedColor = getComputedStyle(tempEl).color;
			document.body.removeChild(tempEl);

			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				this.colorCache.set(variable, fallback);
				return fallback;
			}
			ctx.fillStyle = computedColor;
			ctx.fillRect(0, 0, 1, 1);
			const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

			const finalColor = `rgb(${r}, ${g}, ${b})`;
			this.colorCache.set(variable, finalColor);
			return finalColor;

		} catch (e) {
			console.error(`3D Graph: Could not parse CSS color variable ${variable}`, e);
			this.colorCache.set(variable, fallback);
			return fallback;
		}
	}

	public setGroupsDirty() {
		this.groupsDirty = true;
	}

	private updatePreprocessedGroups() {
		if (!this.groupsDirty) return;
		this.preprocessedGroups = this.settings.groups.map(group => {
			const query = group.query.toLowerCase();
			if (!query) {
				return { color: group.color, query: '', type: 'text' as const };
			}

			if (query.startsWith('path:')) {
				return {
					color: group.color,
					query,
					type: 'path' as const,
					pathQuery: query.substring(5).trim()
				};
			} else if (query.startsWith('tag:')) {
				return {
					color: group.color,
					query,
					type: 'tag' as const,
					tagQuery: query.substring(4).trim().replace(/^#/, '')
				};
			} else if (query.startsWith('file:')) {
				const fileQuery = query.substring(5).trim();
				let fileRegex: RegExp | undefined;
				if (fileQuery.includes('*')) {
					const pattern = fileQuery.replace(/\./g, '\\.').replace(/\*/g, '.*');
					fileRegex = new RegExp(`^${pattern}$`, 'i');
				}
				return {
					color: group.color,
					query,
					type: 'file' as const,
					fileQuery,
					fileRegex
				};
			} else {
				return {
					color: group.color,
					query,
					type: 'text' as const
				};
			}
		}).filter(g => g.query !== '');
		this.groupsDirty = false;
	}

	private getNodeColor(node: GraphNode): string {
		const { useThemeColors, colorHighlight, colorNode, colorTag, colorAttachment } = this.settings;

		if (this.highlightedNodes.has(node.id)) {
			return useThemeColors ? this.getCssColor('--graph-node-focused', colorHighlight) : colorHighlight;
		}

		for (const group of this.preprocessedGroups) {
			const { query, type } = group;

			if (type === 'path') {
				if (node.type !== NodeType.Tag && node.id.toLowerCase().startsWith(group.pathQuery!)) {
					return group.color;
				}
			} else if (type === 'tag') {
				const tagQuery = group.tagQuery!;
				if (node.type === NodeType.Tag && node.name.toLowerCase() === `#${tagQuery}`) {
					return group.color;
				}
				if (node.type === NodeType.File && node.tags?.some(tag => tag.toLowerCase() === tagQuery)) {
					return group.color;
				}
			} else if (type === 'file') {
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
				let nodeContentLower = '';
				if (node.type === NodeType.File) {
					nodeContentLower = this.fileContentCache.get(node.id)?.lowerCaseContent || '';
				}
				if (node.name.toLowerCase().includes(query) || nodeContentLower.includes(query)) {
					return group.color;
				}
			}
		}

		if (useThemeColors) {
			if (node.type === NodeType.Tag) return this.getCssColor('--graph-tags', colorTag);
			if (node.type === NodeType.Attachment) return this.getCssColor('--graph-unresolved', colorAttachment);
			return this.getCssColor('--graph-node', colorNode);
		} else {
			if (node.type === NodeType.Tag) return colorTag;
			if (node.type === NodeType.Attachment) return colorAttachment;
			return colorNode;
		}
	}

	public updateDisplay() {
		if (!this.isGraphInitialized) return;
		this.updatePreprocessedGroups();
		// This function is now only for things that require a full object recreation
		this.graph
			.nodeThreeObject((node: GraphNode) => this.createNodeObject(node));

		// These are now updated dynamically without a full redraw
		this.graph
			.linkWidth((link: GraphLink) => this.highlightedLinks.has(link) ? (this.settings.linkThickness * 2) : this.settings.linkThickness)
			.linkDirectionalParticles((link: GraphLink) => (this.highlightedLinks.has(link) && !this.settings.performanceMode) ? 4 : 0)
			.linkDirectionalParticleWidth(2);
	}

	private hexToRgba(hex: string, alpha: number): string {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	private createNodeObject(node: GraphNode): THREE.Object3D {
		const group = new THREE.Group();

		let shape: NodeShape;
		let size: number;
		switch (node.type) {
			case NodeType.Tag: shape = this.settings.tagShape; size = this.settings.tagNodeSize; break;
			case NodeType.Attachment: shape = this.settings.attachmentShape; size = this.settings.attachmentNodeSize; break;
			default: shape = this.settings.nodeShape; size = this.settings.nodeSize;
		}

		const geometry = this.getSharedGeometry(shape);
		const s = size * 1.5;

		const color = this.getNodeColor(node);
		const mesh = new THREE.Mesh(geometry, this.getSharedMaterial(color));
		mesh.scale.set(s, s, s);

		this.nodeMeshes.set(node, mesh);
		group.add(mesh);

		return group;
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
				controls.addEventListener('change', () => {
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
		if (!this.isGraphInitialized || !this.settings.showNodeLabels || this.settings.performanceMode) return;

		const camera = this.graph.camera();
		const nodes = this.graph.graphData().nodes;

		if (!nodes || !camera) return;

		this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

		if (this.settings.labelOcclusion && this.occludersCacheDirty) {
			this.cachedOccluders = nodes.map((n: GraphNode) => this.nodeMeshes.get(n)).filter(Boolean) as THREE.Mesh[];
			this.occludersCacheDirty = false;
		}

		const raycastCullDistanceSq = this.RAYCAST_CULL_DISTANCE * this.RAYCAST_CULL_DISTANCE;
		const relevantOccluders = this.settings.labelOcclusion
			? this.cachedOccluders.filter(mesh => camera.position.distanceToSquared(mesh.position) < raycastCullDistanceSq)
			: [];

		nodes.forEach((node: GraphNode) => {
			if (this.settings.showLabelsOnHoverOnly) {
				const isHovered = this.hoveredNode && this.hoveredNode.id === node.id;
				const isHighlighted = this.highlightedNodes.has(node.id);
				if (!isHovered && !isHighlighted) {
					this.removeNodeSprite(node);
					return;
				}
			}

			if (node.__threeObj) {
				node.__threeObj.getWorldPosition(this.reusableNodePosition);
			} else {
				this.removeNodeSprite(node);
				return;
			}

			if (!this.frustum.containsPoint(this.reusableNodePosition)) {
				this.removeNodeSprite(node);
				return;
			}

			const distance = camera.position.distanceTo(this.reusableNodePosition);

			const visibleDistance = this.settings.labelDistance;
			const fadeStartDistance = visibleDistance * this.settings.labelFadeThreshold;

			let opacity = 0;

			if (distance <= fadeStartDistance) {
				opacity = 1;
			} else if (distance <= visibleDistance) {
				opacity = 1 - (distance - fadeStartDistance) / (visibleDistance - fadeStartDistance);
			}

			if (opacity > 0 && this.settings.labelOcclusion && relevantOccluders.length > 1) {
				const direction = this.reusableDirection.subVectors(this.reusableNodePosition, camera.position).normalize();
				this.raycaster.set(camera.position, direction);
				const intersects = this.raycaster.intersectObjects(relevantOccluders);
				const mesh = this.nodeMeshes.get(node);

				if (intersects.length > 0 && intersects[0].object !== mesh) {
					if (intersects[0].distance < distance) {
						opacity = 0;
					}
				}
			}

			if (opacity > 0.01) {
				let sprite = this.nodeSprites.get(node);
				if (!sprite) {
					sprite = this.createNodeSprite(node);
				}
				if (sprite && sprite.material) {
					(sprite.material as THREE.SpriteMaterial).opacity = opacity;
					sprite.visible = true;
				}
			} else {
				this.removeNodeSprite(node);
			}
		});
	}

	private createNodeSprite(node: GraphNode): SpriteText {
		const sprite = new SpriteText(node.name);
		const isDarkMode = document.body.classList.contains('theme-dark');
		sprite.color = isDarkMode ? this.settings.labelTextColorDark : this.settings.labelTextColorLight;
		sprite.backgroundColor = this.hexToRgba(this.settings.labelBackgroundColor, this.settings.labelBackgroundOpacity);
		sprite.textHeight = this.settings.labelTextSize;

		let size: number;
		switch (node.type) {
			case NodeType.Tag: size = this.settings.tagNodeSize; break;
			case NodeType.Attachment: size = this.settings.attachmentNodeSize; break;
			default: size = this.settings.nodeSize;
		}
		const s = size * 1.5;
		sprite.position.y = s / 2 + 2;

		this.nodeSprites.set(node, sprite);
		if (node.__threeObj) {
			node.__threeObj.add(sprite);
		}
		return sprite;
	}

	private removeNodeSprite(node: GraphNode) {
		const sprite = this.nodeSprites.get(node);
		if (sprite) {
			sprite.parent?.remove(sprite);
			sprite.geometry?.dispose();
			if (sprite.material) {
				sprite.material.map?.dispose();
				sprite.material.dispose();
			}
			this.nodeSprites.delete(node);
		}
	}

	private handleNodeClick(node: GraphNode, event?: MouseEvent) {
		if (!node) return;

		if (event && (event.ctrlKey || event.metaKey)) {
			this.app.workspace.openLinkText(node.id, node.id, 'tab');
			return;
		}

		if (this.clickTimeout) {
			clearTimeout(this.clickTimeout); this.clickTimeout = null;
			this.handleNodeDoubleClick(node);
		} else {
			this.clickTimeout = setTimeout(() => {
				this.handleNodeSingleClick(node); this.clickTimeout = null;
			}, this.CLICK_DELAY);
		}
	}

	private handleNodeDoubleClick(node: GraphNode) {
		if (node.type === NodeType.File || node.type === NodeType.Attachment) {
			const file = this.app.vault.getAbstractFileByPath(node.id);
			if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
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
				const sourceId = typeof link.source === 'object' ? (link.source as GraphNode).id : (link.source as string);
				const targetId = typeof link.target === 'object' ? (link.target as GraphNode).id : (link.target as string);

				this.highlightedNodes.add(sourceId);
				this.highlightedNodes.add(targetId);
				this.highlightedLinks.add(link);
			});

			if (node.__threeObj && this.settings.zoomOnClick) {
				const distance = 40;
				const nodePosition = new THREE.Vector3();
				node.__threeObj.getWorldPosition(nodePosition);
				const cameraPosition = this.graph.camera().position;
				const direction = new THREE.Vector3().subVectors(cameraPosition, nodePosition).normalize();
				const targetPosition = new THREE.Vector3().addVectors(nodePosition, direction.multiplyScalar(distance));
				this.graph.cameraPosition(targetPosition, nodePosition, 1000);
			}
		}
		this.updateNodeColorsDiff();
		this.graph.linkWidth(this.graph.linkWidth());
		this.graph.linkDirectionalParticles(this.graph.linkDirectionalParticles());
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
		this.graph.linkWidth(this.graph.linkWidth());
		this.graph.linkDirectionalParticles(this.graph.linkDirectionalParticles());
		this.updateLabels();
	}

	private updateNodeColorsDiff() {
		const nodesToUpdate = new Set<string>();
		this.lastHighlightedNodes.forEach(id => nodesToUpdate.add(id));
		this.highlightedNodes.forEach(id => nodesToUpdate.add(id));

		nodesToUpdate.forEach(nodeId => {
			const node = this.nodeMap.get(nodeId);
			if (node) {
				const mesh = this.nodeMeshes.get(node);
				if (mesh) {
					const color = this.getNodeColor(node);
					if (color) {
						mesh.material = this.getSharedMaterial(color);
					}
				}
			}
		});

		// Save current highlights for next diff
		this.lastHighlightedNodes.clear();
		this.highlightedNodes.forEach(id => this.lastHighlightedNodes.add(id));
	}

	private getLinkCurvature(link: ProcessedGraphLink) {
		if (this.settings.performanceMode) return 0;
		const sourceId = typeof link.source === 'object' ? (link.source as GraphNode).id : (link.source as string);
		const targetId = typeof link.target === 'object' ? (link.target as GraphNode).id : (link.target as string);
		const key = `${sourceId}->${targetId}`;
		if (this.reciprocalLinks.has(key)) {
			return sourceId > targetId ? 0.2 : -0.2;
		}
		return 0;
	}

	private matchesFilter(node: GraphNode, filter: Filter): boolean {
		const filterValue = filter.value.trim().toLowerCase();
		if (!filterValue) return false;

		if (filter.type === 'path') {
			return node.id.toLowerCase().includes(filterValue);
		}
		if (filter.type === 'tag') {
			const tagToMatch = filterValue.startsWith('#') ? filterValue.substring(1) : filterValue;
			if (node.type === NodeType.Tag) {
				return node.name.toLowerCase() === `#${tagToMatch}`;
			}
			return node.tags?.some(tag => tag.toLowerCase() === tagToMatch) ?? false;
		}
		return false;
	}

	private async processVaultData(): Promise<{ nodes: GraphNode[], links: { source: string, target: string }[] } | null> {
		const { showAttachments, hideOrphans, showTags, searchQuery, showNeighboringNodes, filters } = this.settings;
		const allFiles = this.app.vault.getFiles();
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		if (!resolvedLinks) return null;

		const allNodesMap = new Map<string, GraphNode>();

		// Prune deleted files from caches to prevent memory leaks
		const allFilePaths = new Set(allFiles.map(f => f.path));
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

		const needsContent = !!searchQuery || this.preprocessedGroups.some(g => {
			return g.type === 'text';
		});

		const CONCURRENCY_LIMIT = 50;
		const readQueue = [...allFiles];
		const workers = Array(Math.min(CONCURRENCY_LIMIT, readQueue.length)).fill(null).map(async () => {
			while (readQueue.length > 0) {
				const file = readQueue.shift()!;
				const cachedNodeInfo = this.processedNodes.get(file.path);

				let node: GraphNode;

				if (cachedNodeInfo && cachedNodeInfo.mtime === file.stat.mtime) {
					node = cachedNodeInfo.node;
					// If search or text groups require content, but cached content doesn't exist, load it
					if (node.type === NodeType.File && needsContent && !this.fileContentCache.has(file.path)) {
						const content = await this.app.vault.cachedRead(file);
						const lowerCaseContent = content.toLowerCase();
						this.fileContentCache.set(file.path, { mtime: file.stat.mtime, content, lowerCaseContent });
					}
				} else {
					const cache = this.app.metadataCache.getFileCache(file);
					const tags = cache ? (getAllTags(cache) || []).map(t => t.startsWith('#') ? t.substring(1) : t) : [];
					const type = file.extension === 'md' ? NodeType.File : NodeType.Attachment;

					if (type === NodeType.File && needsContent) {
						const cachedContent = this.fileContentCache.get(file.path);
						if (!cachedContent || cachedContent.mtime !== file.stat.mtime) {
							const content = await this.app.vault.cachedRead(file);
							const lowerCaseContent = content.toLowerCase();
							this.fileContentCache.set(file.path, { mtime: file.stat.mtime, content, lowerCaseContent });
						}
					}

					node = { id: file.path, name: file.basename, filename: file.name, type, tags };
					this.processedNodes.set(file.path, { node, mtime: file.stat.mtime });
				}

				allNodesMap.set(file.path, node);
			}
		});
		await Promise.all(workers);

		const allLinks: { source: string, target: string }[] = [];
		const existingLinks = new Set<string>();

		for (const sourcePath in resolvedLinks) {
			for (const targetPath in resolvedLinks[sourcePath]) {
				allLinks.push({ source: sourcePath, target: targetPath });
				existingLinks.add(`${sourcePath}->${targetPath}`);
			}
		}

		// Also extract links from frontmatter properties (Properties section)
		for (const file of allFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatterLinks) {
				for (const linkCache of cache.frontmatterLinks) {
					const destFile = this.app.metadataCache.getFirstLinkpathDest(linkCache.link, file.path);
					if (destFile) {
						const linkKey = `${file.path}->${destFile.path}`;
						if (!existingLinks.has(linkKey)) {
							allLinks.push({ source: file.path, target: destFile.path });
							existingLinks.add(linkKey);
						}
					}
				}
			}
		}

		if (showTags) {
			const allTags = new Map<string, GraphNode>();
			allNodesMap.forEach(node => {
				if (node.type === NodeType.File && node.tags) {
					node.tags.forEach(tagName => {
						const tagId = `tag:${tagName}`;
						if (!allTags.has(tagName)) {
							allTags.set(tagName, { id: tagId, name: `#${tagName}`, type: NodeType.Tag });
						}
						const linkKey = `${node.id}->${tagId}`;
						if (!existingLinks.has(linkKey)) {
							allLinks.push({ source: node.id, target: tagId });
							existingLinks.add(linkKey);
						}
					});
				}
			});
			allTags.forEach((tagNode, tagName) => allNodesMap.set(tagNode.id, tagNode));
		}

		let matchedNodes = Array.from(allNodesMap.values());

		// Advanced Filtering Logic
		const activeFilters = filters.filter(f => f.enabled && f.value.trim() !== '');

		if (activeFilters.length > 0) {
			const nodesToKeep = new Set<GraphNode>();
			activeFilters.forEach(filter => {
				matchedNodes.forEach(node => {
					if (this.matchesFilter(node, filter)) {
						nodesToKeep.add(node);
					}
				});
			});
			matchedNodes = Array.from(nodesToKeep);
		}

		if (searchQuery) {
			const lowerCaseFilter = searchQuery.toLowerCase();
			matchedNodes = matchedNodes.filter(node => {
				let nodeContentLower = '';
				if (node.type === NodeType.File) {
					nodeContentLower = this.fileContentCache.get(node.id)?.lowerCaseContent || '';
				}
				return node.name.toLowerCase().includes(lowerCaseFilter) ||
					(node.type !== NodeType.Tag && node.id.toLowerCase().includes(lowerCaseFilter)) ||
					nodeContentLower.includes(lowerCaseFilter);
			});
		}

		let finalNodes: GraphNode[];
		if (showNeighboringNodes && (activeFilters.length > 0 || searchQuery)) {
			const matchedIds = new Set(matchedNodes.map(n => n.id));
			const neighborIds = new Set<string>();

			allLinks.forEach(link => {
				if (matchedIds.has(link.source)) {
					neighborIds.add(link.target);
				} else if (matchedIds.has(link.target)) {
					neighborIds.add(link.source);
				}
			});

			finalNodes = Array.from(allNodesMap.values()).filter(node =>
				matchedIds.has(node.id) || neighborIds.has(node.id)
			);
		} else {
			finalNodes = matchedNodes;
		}

		let nodesToShow = finalNodes.filter(node => {
			if (node.type === NodeType.Tag) return showTags;
			if (node.type === NodeType.Attachment) return showAttachments;
			return true;
		});

		const nodesToShowIds = new Set(nodesToShow.map(n => n.id));
		const linksToShow = allLinks.filter(link => nodesToShowIds.has(link.source) && nodesToShowIds.has(link.target));

		if (hideOrphans) {
			const linkedNodeIds = new Set<string>();
			linksToShow.forEach(link => {
				linkedNodeIds.add(link.source);
				linkedNodeIds.add(link.target);
			});
			nodesToShow = nodesToShow.filter(node => linkedNodeIds.has(node.id));
		}

		return { nodes: nodesToShow, links: linksToShow };
	}

	private cleanupNode(node: GraphNode, options: { cleanMesh?: boolean, cleanGroup?: boolean } = { cleanMesh: true, cleanGroup: true }) {
		if (options.cleanMesh) {
			this.nodeMeshes.delete(node);
		}

		this.removeNodeSprite(node);

		if (options.cleanGroup && node.__threeObj) {
			node.__threeObj.parent?.remove(node.__threeObj);
		}
	}

	async onClose() {
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
			if (typeof this.graph._destructor === 'function') {
				this.graph._destructor();
			}
			this.graph = null;
		}
		if (this.messageEl) {
			this.messageEl.remove();
		}
		if (this.counterEl) {
			this.counterEl.remove();
		}
		this.clearResourceCaches();
		this.colorCache.clear();
		this.processedNodes.clear();
		this.nodeMap.clear();
		this.reciprocalLinks.clear();
		this.linkAdjacencyIndex.clear();
		this.lastHighlightedNodes.clear();
		this.controlsListenerAdded = false;
	}
}
