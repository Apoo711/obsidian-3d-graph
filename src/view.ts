// src/view.ts
import { ItemView, WorkspaceLeaf, TFile, Setting, setIcon, debounce } from 'obsidian';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import SpriteText from 'three-spritetext';
import Graph3DPlugin from '../main';
import { Graph3DPluginSettings, GraphNode, GraphLink, NodeShape, NodeType } from './types';

export const VIEW_TYPE_3D_GRAPH = "3d-graph-view";

export class Graph3DView extends ItemView {
	private graph: any;
	private plugin: Graph3DPlugin;
	private settings: Graph3DPluginSettings;
	private resizeObserver: ResizeObserver;
	private raycaster = new THREE.Raycaster();

	// Reusable objects for performance optimization
	private reusableNodePosition = new THREE.Vector3();
	private reusableDirection = new THREE.Vector3();
	private cachedOccluders: THREE.Mesh[] = [];
	private occludersCacheDirty = true;

	// WeakMaps for type safety and automatic garbage collection
	private nodeMeshes = new WeakMap<GraphNode, THREE.Mesh>();
	private nodeSprites = new WeakMap<GraphNode, SpriteText>();

	private highlightedNodes = new Set<string>();
	private highlightedLinks = new Set<object>();
	private selectedNode: string | null = null;

	private colorCache = new Map<string, string>();

	private graphContainer: HTMLDivElement;
	private messageEl: HTMLDivElement;
	private settingsPanel: HTMLDivElement;
	private settingsToggleButton: HTMLDivElement;

	private chargeForce: any;
	private centerForce: any;
	private linkForce: any;

	private clickTimeout: any = null;
	private isGraphInitialized = false;
	private isUpdating = false;
	private readonly CLICK_DELAY = 250;

	// Throttling for label updates
	private lastLabelUpdateTime = 0;
	private readonly LABEL_UPDATE_INTERVAL = 100; // ms

	constructor(leaf: WorkspaceLeaf, plugin: Graph3DPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settings = plugin.settings;
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
		rootContainer.addClass('graph-3d-view-content');

		const viewWrapper = rootContainer.createEl('div', {cls: 'graph-3d-view-wrapper'});

		this.graphContainer = viewWrapper.createEl('div', {cls: 'graph-3d-container'});
		this.messageEl = viewWrapper.createEl('div', {cls: 'graph-3d-message'});

		this.addLocalControls();
		this.initializeGraph();

		this.resizeObserver = new ResizeObserver(() => {
			if (this.graph && this.isGraphInitialized) {
				this.graph.width(this.graphContainer.offsetWidth);
				this.graph.height(this.graphContainer.offsetHeight);
			}
		});
		this.resizeObserver.observe(this.graphContainer);
	}

	private addLocalControls() {
		const controlsContainer = this.contentEl.createEl('div', {cls: 'graph-3d-controls-container'});
		this.settingsToggleButton = controlsContainer.createEl('div', {cls: 'graph-3d-settings-toggle'});
		setIcon(this.settingsToggleButton, 'settings');
		this.settingsToggleButton.setAttribute('aria-label', 'Graph settings');
		this.settingsPanel = controlsContainer.createEl('div', {cls: 'graph-3d-settings-panel'});
		this.settingsToggleButton.addEventListener('click', () => {
			this.settingsPanel.classList.toggle('is-open');
		});
		this.renderSettingsPanel();
	}

	public renderSettingsPanel() {
		this.settingsPanel.empty();
		this.renderSearchSettings(this.settingsPanel);
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
					this.updateData({useCache: true, reheat: false});
				}, 500, true)));

		new Setting(container)
			.setName('Show neighboring nodes')
			.addToggle(toggle => toggle
				.setValue(this.settings.showNeighboringNodes)
				.onChange(async (value) => {
					this.settings.showNeighboringNodes = value;
					await this.plugin.saveSettings();
					if (this.settings.searchQuery) {
						this.updateData({useCache: true, reheat: false});
					}
				}));
	}

	private renderFilterSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Filters');

		new Setting(container).setName('Show tags').addToggle(toggle => toggle
			.setValue(this.settings.showTags)
			.onChange(async (value) => {
				this.settings.showTags = value;
				await this.plugin.saveSettings();
				this.updateData({useCache: true, reheat: false});
			}));

		new Setting(container).setName('Show attachments').addToggle(toggle => toggle
			.setValue(this.settings.showAttachments)
			.onChange(async (value) => {
				this.settings.showAttachments = value;
				await this.plugin.saveSettings();
				this.updateData({useCache: true, reheat: false});
			}));

		new Setting(container).setName('Hide orphans').addToggle(toggle => toggle
			.setValue(this.settings.hideOrphans)
			.onChange(async (value) => {
				this.settings.hideOrphans = value;
				await this.plugin.saveSettings();
				this.updateData({useCache: true, reheat: false});
			}));
	}

	private renderGroupSettings(container: HTMLElement) {
		const groupContainer = container.createDiv();
		const render = () => {
			groupContainer.empty();
			new Setting(groupContainer).setHeading().setName('Groups');

			this.settings.groups.forEach((group, index) => {
				new Setting(groupContainer)
					.addText(text => text
						.setPlaceholder('path:, tag:, file:, or text')
						.setValue(group.query)
						.onChange(async (value) => {
							group.query = value;
							await this.plugin.saveSettings();
							this.updateDisplay();
							this.updateColors();
						}))
					.addColorPicker(color => color
						.setValue(group.color)
						.onChange(async (value) => {
							group.color = value;
							await this.plugin.saveSettings();
							this.updateDisplay();
							this.updateColors();
						}))
					.addExtraButton(button => button
						.setIcon('cross')
						.setTooltip('Remove group')
						.onClick(async () => {
							this.settings.groups.splice(index, 1);
							await this.plugin.saveSettings();
							render();
							this.updateDisplay();
							this.updateColors();
						}));
			});

			new Setting(groupContainer)
				.addButton(button => button
					.setButtonText('Add new group')
					.onClick(async () => {
						this.settings.groups.push({query: '', color: '#ffffff'});
						await this.plugin.saveSettings();
						render();
					}));
		};
		render();
	}

	private renderAppearanceSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Appearance');

		const updateDisplayAndColors = async () => {
			await this.plugin.saveSettings();
			this.updateDisplay();
			this.updateColors();
		}

		new Setting(container).setName('Node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.nodeSize).setDynamicTooltip()
			.onChange(async (v) => {
				this.settings.nodeSize = v;
				await updateDisplayAndColors();
			}));
		new Setting(container).setName('Tag node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.tagNodeSize).setDynamicTooltip()
			.onChange(async (v) => {
				this.settings.tagNodeSize = v;
				await updateDisplayAndColors();
			}));
		new Setting(container).setName('Attachment node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.attachmentNodeSize).setDynamicTooltip()
			.onChange(async (v) => {
				this.settings.attachmentNodeSize = v;
				await updateDisplayAndColors();
			}));
		new Setting(container).setName('Link thickness').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.settings.linkThickness).setDynamicTooltip()
			.onChange(async (v) => {
				this.settings.linkThickness = v;
				await updateDisplayAndColors();
			}));

		new Setting(container).setName('Node shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.settings.nodeShape)
			.onChange(async (value: NodeShape) => {
				this.settings.nodeShape = value;
				await updateDisplayAndColors()
			}));
		new Setting(container).setName('Tag shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.settings.tagShape)
			.onChange(async (value: NodeShape) => {
				this.settings.tagShape = value;
				await updateDisplayAndColors()
			}));
		new Setting(container).setName('Attachment shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.settings.attachmentShape)
			.onChange(async (value: NodeShape) => {
				this.settings.attachmentShape = value;
				await updateDisplayAndColors()
			}));
	}

	private renderLabelSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Labels');

		new Setting(container)
			.setName('Show node labels')
			.addToggle(toggle => toggle.setValue(this.settings.showNodeLabels)
				.onChange(async (value) => {
					this.settings.showNodeLabels = value;
					await this.plugin.saveSettings();

					if (!value) {
						this.graph.graphData().nodes.forEach((node: GraphNode) => this.cleanupNode(node, {cleanMesh: false}));
					}
					this.updateDisplay();
					this.updateColors();
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
			.addToggle(toggle => toggle.setValue(this.settings.labelOcclusion)
				.onChange(async (value) => {
					this.settings.labelOcclusion = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderInteractionSettings(container: HTMLElement) {
		new Setting(container).setHeading().setName('Interaction');

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
			this.updateData({useCache: false, reheat: true});
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
			.setName('Link force')
			.addSlider(slider => slider
				.setLimits(0, 0.1, 0.001)
				.setValue(this.settings.linkForce)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.settings.linkForce = value;
					await forceChangeHandler();
				}));
	}

	private initializeForces() {
		this.chargeForce = this.graph.d3Force('charge');
		this.centerForce = this.graph.d3Force('center');
		this.linkForce = this.graph.d3Force('link');
	}

	initializeGraph() {
		this.app.workspace.onLayoutReady(async () => {
			if (!this.graphContainer) return;

			const Graph = (ForceGraph3D as any).default || ForceGraph3D;
			this.graph = Graph()(this.graphContainer)
				.onNodeClick((node: GraphNode) => this.handleNodeClick(node))
				.onEngineTick(() => {
					const now = performance.now();
					if (now - this.lastLabelUpdateTime > this.LABEL_UPDATE_INTERVAL) {
						this.lastLabelUpdateTime = now;
						this.updateLabels();
					}
				});

			this.graph.graphData({nodes: [], links: []});

			this.initializeForces();
			this.graph.pauseAnimation();
			this.isGraphInitialized = true;

			setTimeout(() => {
				this.updateData({isFirstLoad: true});
			}, 100);
		});
	}

	public async updateData(options: { useCache?: boolean; reheat?: boolean; isFirstLoad?: boolean } = {}) {
		const {useCache = true, reheat = false, isFirstLoad = false} = options;

		if (!this.isGraphInitialized || this.isUpdating) {
			return;
		}
		this.isUpdating = true;

		try {
			const nodePositions = new Map<string, { x: number; y: number; z: number }>();
			if (useCache && this.graph.graphData().nodes.length > 0) {
				this.graph.graphData().nodes.forEach((node: GraphNode) => {
					if (node.id && node.x !== undefined && node.y !== undefined && node.z !== undefined) {
						nodePositions.set(node.id, {x: node.x, y: node.y, z: node.z});
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
							let connectedNodePos: { x: number, y: number, z: number } | undefined;

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
				this.graph.graphData(newData);
				this.occludersCacheDirty = true;

				this.updateForces();
				this.updateDisplay();
				this.updateColors();
				this.updateControls();

				if (isFirstLoad || reheat) {
					this.graph.d3AlphaDecay(0.0228);
					this.graph.d3VelocityDecay(0.4);
					this.graph.d3ReheatSimulation();
				} else if (useCache) {
					this.graph.d3AlphaDecay(0.1);
					this.graph.d3VelocityDecay(0.6);
				}

				this.graph.resumeAnimation();
			} else {
				if (this.graph && typeof this.graph._destructor === 'function') {
					this.graph._destructor();
				}
				const Graph = (ForceGraph3D as any).default || ForceGraph3D;
				this.graph = Graph()(this.graphContainer)
					.onNodeClick((node: GraphNode) => this.handleNodeClick(node))
					.graphData({nodes: [], links: []});

				this.initializeForces();

				this.colorCache.clear();
				const bgColor = this.settings.useThemeColors
					? this.getCssColor('--background-primary', '#000000')
					: this.settings.backgroundColor;
				this.graph.backgroundColor(bgColor);
				this.messageEl.setText("No search results found.");
				this.messageEl.addClass('is-visible');
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

		this.colorCache.clear();

		const bgColor = this.settings.useThemeColors ? this.getCssColor('--background-primary', '#000000') : this.settings.backgroundColor;
		this.graph.backgroundColor(bgColor);

		this.graph.graphData().nodes.forEach((node: GraphNode) => {
			const mesh = this.nodeMeshes.get(node);
			if (mesh && mesh.material) {
				const color = this.getNodeColor(node);
				if (color) {
					try {
						(mesh.material as THREE.MeshLambertMaterial).color.set(color);
					} catch (e) {
						console.error(`3D Graph: Invalid color '${color}' for node`, node, e);
					}
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

	private getNodeColor(node: GraphNode): string {
		const {useThemeColors, colorHighlight, colorNode, colorTag, colorAttachment, groups} = this.settings;

		if (this.highlightedNodes.has(node.id)) {
			return useThemeColors ? this.getCssColor('--graph-node-focused', colorHighlight) : colorHighlight;
		}

		for (const group of groups) {
			const query = group.query.toLowerCase();
			if (!query) continue;

			if (query.startsWith('path:')) {
				const pathQuery = query.substring(5).trim();
				if (node.type !== NodeType.Tag && node.id.toLowerCase().startsWith(pathQuery)) {
					return group.color;
				}
			} else if (query.startsWith('tag:')) {
				const tagQuery = query.substring(4).trim().replace(/^#/, '');
				if (node.type === NodeType.Tag && node.name.toLowerCase() === `#${tagQuery}`) {
					return group.color;
				}
				if (node.type === NodeType.File && node.tags?.some(tag => tag.toLowerCase() === tagQuery)) {
					return group.color;
				}
			} else if (query.startsWith('file:')) {
				const fileQuery = query.substring(5).trim().toLowerCase();
				if ((node.type === NodeType.File || node.type === NodeType.Attachment) && node.filename) {
					if (fileQuery.includes('*')) {
						const pattern = fileQuery.replace(/\./g, '\\.').replace(/\*/g, '.*');
						const regex = new RegExp(`^${pattern}$`, 'i');
						if (regex.test(node.filename)) {
							return group.color;
						}
					} else {
						if (node.filename.toLowerCase() === fileQuery) {
							return group.color;
						}
					}
				}
			} else {
				if (node.name.toLowerCase().includes(query) || (node.content && node.content.toLowerCase().includes(query))) {
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
		this.graph
			.nodeThreeObject((node: GraphNode) => this.createNodeObject(node))
			.linkWidth((link: GraphLink) => this.highlightedLinks.has(link) ? (this.settings.linkThickness * 1.5) : this.settings.linkThickness);
	}

	private createNodeObject(node: GraphNode): THREE.Object3D {
		const group = new THREE.Group();

		let shape: NodeShape;
		let size: number;
		switch (node.type) {
			case NodeType.Tag:
				shape = this.settings.tagShape;
				size = this.settings.tagNodeSize;
				break;
			case NodeType.Attachment:
				shape = this.settings.attachmentShape;
				size = this.settings.attachmentNodeSize;
				break;
			default:
				shape = this.settings.nodeShape;
				size = this.settings.nodeSize;
		}

		let geometry: THREE.BufferGeometry;
		const s = size * 1.5;

		switch (shape) {
			case NodeShape.Cube:
				geometry = new THREE.BoxGeometry(s, s, s);
				break;
			case NodeShape.Pyramid:
				geometry = new THREE.ConeGeometry(s / 1.5, s, 4);
				break;
			case NodeShape.Tetrahedron:
				geometry = new THREE.TetrahedronGeometry(s / 1.2);
				break;
			default:
				geometry = new THREE.SphereGeometry(s / 2);
		}

		const color = this.getNodeColor(node);
		const material = new THREE.MeshLambertMaterial({
			color: '#ffffff',
			transparent: true,
			opacity: 0.9
		});

		try {
			material.color.set(color);
		} catch (e) {
			console.error(`3D Graph: Could not set material color to '${color}'`, e);
			material.color.set(this.settings.colorNode);
		}

		const mesh = new THREE.Mesh(geometry, material);
		this.nodeMeshes.set(node, mesh);
		group.add(mesh);

		if (this.settings.showNodeLabels) {
			const sprite = new SpriteText(node.name);
			sprite.color = this.settings.labelTextColor;
			sprite.textHeight = this.settings.labelTextSize;
			sprite.position.y = s / 2 + 2;
			this.nodeSprites.set(node, sprite);
			group.add(sprite);
		}

		return group;
	}

	public updateForces() {
		if (!this.isGraphInitialized) return;

		const {centerForce, repelForce, linkForce} = this.settings;

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

	public updateControls() {
		if (!this.isGraphInitialized) return;
		const {rotateSpeed, panSpeed, zoomSpeed} = this.settings;
		const controls = this.graph.controls();
		if (controls) {
			controls.rotateSpeed = rotateSpeed;
			controls.panSpeed = panSpeed;
			controls.zoomSpeed = zoomSpeed;
		}
	}

	private updateLabels() {
		if (!this.isGraphInitialized || !this.settings.showNodeLabels) return;

		const camera = this.graph.camera();
		const nodes = this.graph.graphData().nodes;

		if (!nodes || !camera) return;

		if (this.settings.labelOcclusion && this.occludersCacheDirty) {
			this.cachedOccluders = nodes.map((n: GraphNode) => this.nodeMeshes.get(n)).filter(Boolean) as THREE.Mesh[];
			this.occludersCacheDirty = false;
		}

		nodes.forEach((node: GraphNode) => {
			const sprite = this.nodeSprites.get(node);
			if (!sprite) return;

			if (node.__threeObj) {
				node.__threeObj.getWorldPosition(this.reusableNodePosition);
			} else {
				sprite.visible = false;
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

			if (opacity > 0 && this.settings.labelOcclusion && this.cachedOccluders.length > 1) {
				const direction = this.reusableDirection.subVectors(this.reusableNodePosition, camera.position).normalize();
				this.raycaster.set(camera.position, direction);
				const intersects = this.raycaster.intersectObjects(this.cachedOccluders);
				const mesh = this.nodeMeshes.get(node);

				if (intersects.length > 0 && intersects[0].object !== mesh) {
					if (intersects[0].distance < distance) {
						opacity = 0;
					}
				}
			}

			sprite.material.opacity = opacity;
			sprite.visible = opacity > 0.01;
		});
	}

	private handleNodeClick(node: GraphNode) {
		if (!node) return;

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

			const allLinks = this.graph.graphData().links;

			allLinks.forEach((link: GraphLink) => {
				const sourceId = typeof link.source === 'object' ? (link.source as GraphNode).id : link.source;
				const targetId = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target;

				if (sourceId === node.id) {
					this.highlightedNodes.add(targetId);
					this.highlightedLinks.add(link);
				} else if (targetId === node.id) {
					this.highlightedNodes.add(sourceId);
					this.highlightedLinks.add(link);
				}
			});

			if (node.__threeObj && this.settings.zoomOnClick) {
				const allNodes = this.graph.graphData().nodes;
				const highlightedNodeObjects = allNodes
					.filter((n: GraphNode) => this.highlightedNodes.has(n.id) && n.__threeObj)
					.map((n: GraphNode) => n.__threeObj);

				if (highlightedNodeObjects.length > 0) {
					const box = new THREE.Box3().setFromObject(highlightedNodeObjects[0]);
					highlightedNodeObjects.slice(1).forEach((obj: THREE.Object3D) => box.expandByObject(obj));

					const center = box.getCenter(new THREE.Vector3());
					const size = box.getSize(new THREE.Vector3());

					const maxDim = Math.max(size.x, size.y, size.z);
					const cameraZ = maxDim * 2.5;

					this.graph.cameraPosition({
						x: center.x,
						y: center.y,
						z: center.z + cameraZ
					}, center, 1000);
				}
			}
		}
		this.updateColors();
	}

	private async processVaultData(): Promise<{
		nodes: GraphNode[],
		links: { source: string, target: string }[]
	} | null> {
		const {showAttachments, hideOrphans, showTags, searchQuery, showNeighboringNodes} = this.settings;
		const allFiles = this.app.vault.getFiles();
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		if (!resolvedLinks) return null;

		const allNodesMap = new Map<string, GraphNode>();

		for (const file of allFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = cache?.tags?.map(t => t.tag.substring(1)) || [];
			const type = file.extension === 'md' ? NodeType.File : NodeType.Attachment;

			let content = '';
			if (type === NodeType.File) {
				content = await this.app.vault.cachedRead(file);
			}

			allNodesMap.set(file.path, {id: file.path, name: file.basename, filename: file.name, type, tags, content});
		}


		const allLinks: { source: string, target: string }[] = [];
		for (const sourcePath in resolvedLinks) {
			for (const targetPath in resolvedLinks[sourcePath]) {
				allLinks.push({source: sourcePath, target: targetPath});
			}
		}

		if (showTags) {
			const allTags = new Map<string, GraphNode>();
			allNodesMap.forEach(node => {
				if (node.type === NodeType.File && node.tags) {
					node.tags.forEach(tagName => {
						const tagId = `tag:${tagName}`;
						if (!allTags.has(tagName)) {
							allTags.set(tagName, {id: tagId, name: `#${tagName}`, type: NodeType.Tag});
						}
						allLinks.push({source: node.id, target: tagId});
					});
				}
			});
			allTags.forEach((tagNode, tagName) => allNodesMap.set(tagNode.id, tagNode));
		}

		let finalNodes = Array.from(allNodesMap.values());

		if (searchQuery) {
			const lowerCaseFilter = searchQuery.toLowerCase();
			const matchingNodeIds = new Set<string>();

			finalNodes.forEach(node => {
				const nodeContent = node.content || '';
				if (node.name.toLowerCase().includes(lowerCaseFilter) ||
					(node.type !== NodeType.Tag && node.id.toLowerCase().includes(lowerCaseFilter)) ||
					nodeContent.toLowerCase().includes(lowerCaseFilter)
				) {
					matchingNodeIds.add(node.id);
				}
			});

			let finalIdsToShow = new Set(matchingNodeIds);

			if (showNeighboringNodes) {
				const adjacencyMap: Map<string, Set<string>> = new Map();
				allNodesMap.forEach(node => adjacencyMap.set(node.id, new Set()));
				allLinks.forEach(link => {
					adjacencyMap.get(link.source)?.add(link.target);
					adjacencyMap.get(link.target)?.add(link.source);
				});
				matchingNodeIds.forEach(nodeId => {
					adjacencyMap.get(nodeId)?.forEach(neighborId => finalIdsToShow.add(neighborId));
				});
			}

			finalNodes = finalNodes.filter(node => finalIdsToShow.has(node.id));
		}

		const finalNodeIds = new Set(finalNodes.map(n => n.id));
		let finalLinks = allLinks.filter(link => finalNodeIds.has(link.source) && finalNodeIds.has(link.target));

		let nodesToShow = finalNodes.filter(node => {
			if (node.type === NodeType.Tag) return showTags;
			if (node.type === NodeType.Attachment) return showAttachments;
			return true;
		});

		let nodesToShowIds = new Set(nodesToShow.map(n => n.id));
		let linksToShow = finalLinks.filter(link => nodesToShowIds.has(link.source) && nodesToShowIds.has(link.target));

		if (hideOrphans) {
			const linkedNodeIds = new Set<string>();
			linksToShow.forEach(link => {
				linkedNodeIds.add(link.source);
				linkedNodeIds.add(link.target);
			});
			nodesToShow = nodesToShow.filter(node => linkedNodeIds.has(node.id));

			const visibleNodeIds = new Set(nodesToShow.map(n => n.id));
			linksToShow = linksToShow.filter(l => visibleNodeIds.has(l.source) && visibleNodeIds.has(l.target));
		}

		return {nodes: nodesToShow, links: linksToShow};
	}

	private cleanupNode(node: GraphNode, options: { cleanMesh?: boolean } = {cleanMesh: true}) {
		if (options.cleanMesh) {
			const mesh = this.nodeMeshes.get(node);
			if (mesh) {
				mesh.geometry?.dispose();
				(mesh.material as THREE.Material)?.dispose();
				this.nodeMeshes.delete(node);
			}
		}

		const sprite = this.nodeSprites.get(node);
		if (sprite) {
			sprite.parent?.remove(sprite);
			sprite.geometry?.dispose();
			sprite.material?.dispose();
			this.nodeSprites.delete(node);
		}
	}

	async onClose() {
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
	}
}
