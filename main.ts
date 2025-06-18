// main.ts
import { App, ItemView, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, debounce } from 'obsidian';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';

export const VIEW_TYPE_3D_GRAPH = "3d-graph-view";

// --- Interfaces and Enums ---

interface GraphGroup {
	query: string;
	color: string;
}

enum NodeShape { Sphere = 'Sphere', Cube = 'Cube', Pyramid = 'Pyramid', Tetrahedron = 'Tetrahedron' }

interface Graph3DPluginSettings {
	showAttachments: boolean;
	hideOrphans: boolean;
	showTags: boolean;
	searchQuery: string;
	groups: GraphGroup[];
	useThemeColors: boolean;
	colorNode: string;
	colorTag: string;
	colorAttachment: string;
	colorLink: string;
	colorHighlight: string;
	backgroundColor: string;
	nodeSize: number;
	tagNodeSize: number;
	attachmentNodeSize: number;
	linkThickness: number;
	centerForce: number;
	repelForce: number;
	linkForce: number;
	nodeShape: NodeShape;
	tagShape: NodeShape;
	attachmentShape: NodeShape;
	zoomOnClick: boolean;
	showNeighboringNodes: boolean;
	rotateSpeed: number;
	panSpeed: number;
	zoomSpeed: number;
}

const DEFAULT_SETTINGS: Graph3DPluginSettings = {
	showAttachments: false,
	hideOrphans: false,
	showTags: false,
	searchQuery: '',
	groups: [],
	useThemeColors: true,
	colorNode: '#2080F0',
	colorTag: '#9A49E8',
	colorAttachment: '#75B63A',
	colorLink: '#666666',
	colorHighlight: '#FFB800',
	backgroundColor: '#0E0E10',
	nodeSize: 1.5,
	tagNodeSize: 1.0,
	attachmentNodeSize: 1.2,
	linkThickness: 1,
	centerForce: 0.1,
	repelForce: 10,
	linkForce: 0.01,
	nodeShape: NodeShape.Sphere,
	tagShape: NodeShape.Tetrahedron,
	attachmentShape: NodeShape.Cube,
	zoomOnClick: true,
	showNeighboringNodes: true,
	rotateSpeed: 1.0,
	panSpeed: 1.0,
	zoomSpeed: 1.0,
};

enum NodeType { File, Tag, Attachment }

interface GraphNode {
	id: string;
	name: string;
	filename?: string;
	type: NodeType;
	tags?: string[];
	content?: string;
	__threeObj?: THREE.Mesh;
}

// **FIX**: Add an interface for link objects to satisfy strict type checking.
interface GraphLink {
	source: string | GraphNode;
	target: string | GraphNode;
}


// --- Main View Class ---

class Graph3DView extends ItemView {
	private graph: any;
	private plugin: Graph3DPlugin;
	private settings: Graph3DPluginSettings;
	private resizeObserver: ResizeObserver;

	private highlightedNodes = new Set<string>();
	private highlightedLinks = new Set<object>();
	private selectedNode: string | null = null;

	private graphContainer: HTMLDivElement;
	private messageEl: HTMLDivElement;
	private clickTimeout: any = null;
	private isGraphInitialized = false;
	private isUpdating = false;
	private readonly CLICK_DELAY = 250;

	constructor(leaf: WorkspaceLeaf, plugin: Graph3DPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settings = plugin.settings;
	}

	getViewType() { return VIEW_TYPE_3D_GRAPH; }
	getDisplayText() { return "3D Graph"; }

	async onOpen() {
		const rootContainer = this.contentEl;
		rootContainer.empty();

		const viewWrapper = rootContainer.createEl('div');
		viewWrapper.style.position = 'relative';
		viewWrapper.style.width = '100%';
		viewWrapper.style.height = '100%';

		this.graphContainer = viewWrapper.createEl('div', { cls: 'graph-3d-container' });
		this.messageEl = viewWrapper.createEl('div', { cls: 'graph-3d-message' });

		this.initializeGraph();

		this.resizeObserver = new ResizeObserver(() => {
			if (this.graph && this.isGraphInitialized) {
				this.graph.width(this.graphContainer.offsetWidth);
				this.graph.height(this.graphContainer.offsetHeight);
			}
		});
		this.resizeObserver.observe(this.graphContainer);
	}

	initializeGraph() {
		this.app.workspace.onLayoutReady(async () => {
			if (!this.graphContainer) return;

			const Graph = (ForceGraph3D as any).default || ForceGraph3D;
			this.graph = Graph()(this.graphContainer)
				.onNodeClick((node: GraphNode) => this.handleNodeClick(node))
				.graphData({ nodes: [], links: [] });

			this.graph.pauseAnimation();
			this.isGraphInitialized = true;

			setTimeout(() => {
				this.updateData()
			}, 100);
		});
	}

	public updateAll() {
		if (!this.isGraphInitialized) return;
		this.updateDisplay();
		this.updateColors();
		this.updateForces();
	}

	public async updateData() {
		if (!this.isGraphInitialized || this.isUpdating) {
			return;
		}

		this.isUpdating = true;
		try {
			const newData = await this.processVaultData();
			const hasNodes = newData && newData.nodes.length > 0;

			if (hasNodes) {
				this.graph.pauseAnimation();
				this.messageEl.style.display = 'none';
				this.graph.graphData(newData);
				this.updateAll();
				this.graph.resumeAnimation();
			} else {
				if (this.graph && typeof this.graph._destructor === 'function') {
					this.graph._destructor();
				}
				const Graph = (ForceGraph3D as any).default || ForceGraph3D;
				this.graph = Graph()(this.graphContainer)
					.onNodeClick((node: GraphNode) => this.handleNodeClick(node))
					.graphData({ nodes: [], links: [] });

				const bgColor = this.settings.useThemeColors ? this.getCssColor('--background-primary', '#000000') : this.settings.backgroundColor;
				this.graph.backgroundColor(bgColor);
				this.messageEl.setText("No search results found.");
				this.messageEl.style.display = 'block';
				this.graph.pauseAnimation();
			}
		} catch (error) {
			console.error('3D Graph: An error occurred during updateData:', error);
		}
		finally {
			this.isUpdating = false;
		}
	}

	public updateColors() {
		if (!this.isGraphInitialized) return;
		const bgColor = this.settings.useThemeColors ? this.getCssColor('--background-primary', '#000000') : this.settings.backgroundColor;
		this.graph.backgroundColor(bgColor);

		this.graph.graphData().nodes.forEach((node: GraphNode) => {
			if (node.__threeObj && node.__threeObj.material) {
				const color = this.getNodeColor(node);
				if (color) {
					try {
						// **FIX**: Assert the material type to access .color property.
						(node.__threeObj.material as THREE.MeshLambertMaterial).color.set(color);
					} catch (e) {
						console.error(`3D Graph: Invalid color '${color}' for node`, node, e);
					}
				}
			}
		});

		const linkHighlightColor = this.settings.useThemeColors ? this.getCssColor('--graph-node-focused', this.settings.colorHighlight) : this.settings.colorHighlight;
		const linkColor = this.settings.useThemeColors ? this.getCssColor('--graph-line', this.settings.colorLink) : this.settings.colorLink;
		// **FIX**: Add explicit type for the link parameter.
		this.graph.linkColor((link: GraphLink) => this.highlightedLinks.has(link) ? linkHighlightColor : linkColor);
	}

	private getCssColor(variable: string, fallback: string): string {
		try {
			const tempEl = document.createElement('div');
			tempEl.style.display = 'none';
			tempEl.style.color = `var(${variable})`;
			document.body.appendChild(tempEl);
			let computedColor = getComputedStyle(tempEl).color;
			document.body.removeChild(tempEl);

			const srgbMatch = computedColor.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)/);
			if (srgbMatch) {
				const r = Math.round(parseFloat(srgbMatch[1]) * 255);
				const g = Math.round(parseFloat(srgbMatch[2]) * 255);
				const b = Math.round(parseFloat(srgbMatch[3]) * 255);
				computedColor = `rgb(${r}, ${g}, ${b})`;
			}

			return computedColor || fallback;
		} catch (e) {
			console.error(`3D Graph: Could not parse CSS color variable ${variable}`, e);
			return fallback;
		}
	}

	private getNodeColor(node: GraphNode): string {
		const { useThemeColors, colorHighlight, colorNode, colorTag, colorAttachment, groups } = this.settings;

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
			.nodeLabel('name')
			.nodeThreeObject((node: GraphNode) => this.createNodeObject(node))
			.linkWidth((link: GraphLink) => this.highlightedLinks.has(link) ? (this.settings.linkThickness * 1.5) : this.settings.linkThickness);
	}

	private createNodeObject(node: GraphNode): THREE.Mesh {
		let shape: NodeShape;
		let size: number;
		switch (node.type) {
			case NodeType.Tag: shape = this.settings.tagShape; size = this.settings.tagNodeSize; break;
			case NodeType.Attachment: shape = this.settings.attachmentShape; size = this.settings.attachmentNodeSize; break;
			default: shape = this.settings.nodeShape; size = this.settings.nodeSize;
		}

		let geometry: THREE.BufferGeometry;
		const s = size * 1.5;

		switch (shape) {
			case NodeShape.Cube: geometry = new THREE.BoxGeometry(s, s, s); break;
			case NodeShape.Pyramid: geometry = new THREE.ConeGeometry(s / 1.5, s, 4); break;
			case NodeShape.Tetrahedron: geometry = new THREE.TetrahedronGeometry(s / 1.2); break;
			default: geometry = new THREE.SphereGeometry(s / 2);
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
		}

		return new THREE.Mesh(geometry, material);
	}

	public updateForces() {
		if (!this.isGraphInitialized) return;

		const { centerForce, repelForce, linkForce, rotateSpeed, panSpeed, zoomSpeed } = this.settings;

		const forceSim = this.graph.d3Force('charge');
		if (forceSim) {
			this.graph.d3Force('center')?.strength(centerForce);
			this.graph.d3Force('charge').strength(-repelForce);
			this.graph.d3Force('link')?.strength(linkForce);
		}

		const controls = this.graph.controls();
		if (controls) {
			controls.rotateSpeed = rotateSpeed;
			controls.panSpeed = panSpeed;
			controls.zoomSpeed = zoomSpeed;
		}

		if (this.graph.graphData().nodes.length > 0) {
			this.graph.d3ReheatSimulation();
		}
	}

	private handleNodeClick(node: GraphNode) {
		if (!node) return;

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

			const allLinks = this.graph.graphData().links;

			// **FIX**: Add explicit type for the link parameter.
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
					// **FIX**: Add explicit type for the obj parameter.
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

	private async processVaultData(): Promise<{ nodes: GraphNode[], links: { source: string, target: string }[] } | null> {
		const { showAttachments, hideOrphans, showTags, searchQuery, showNeighboringNodes } = this.settings;
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

			allNodesMap.set(file.path, { id: file.path, name: file.basename, filename: file.name, type, tags, content });
		}


		const allLinks: { source: string, target: string }[] = [];
		for (const sourcePath in resolvedLinks) {
			for (const targetPath in resolvedLinks[sourcePath]) {
				allLinks.push({ source: sourcePath, target: targetPath });
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
						allLinks.push({ source: node.id, target: tagId });
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

		return { nodes: nodesToShow, links: linksToShow };
	}

	async onClose() {
		if (this.clickTimeout) clearTimeout(this.clickTimeout);
		this.resizeObserver?.disconnect();
		if (this.graph) {
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

class Graph3DSettingsTab extends PluginSettingTab {
	plugin: Graph3DPlugin;
	constructor(app: App, plugin: Graph3DPlugin) { super(app, plugin); this.plugin = plugin; }

	private triggerUpdate(options: { redrawData?: boolean, updateForces?: boolean, updateDisplay?: boolean }) {
		this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH).forEach(leaf => {
			if (leaf.view instanceof Graph3DView) {
				if (options.redrawData) {
					leaf.view.updateData();
				} else if (options.updateDisplay) {
					leaf.view.updateDisplay();
					leaf.view.updateColors();
				} else if (options.updateForces) {
					leaf.view.updateForces();
				} else {
					leaf.view.updateColors();
				}
			}
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: '3D Graph Settings' });

		containerEl.createEl('h3', { text: 'Search' });
		new Setting(containerEl).setName('Search term').setDesc('Only show notes containing this text.')
			.addText(text => text.setPlaceholder('Enter search term...')
				.setValue(this.plugin.settings.searchQuery)
				.onChange(debounce(async (value) => {
					this.plugin.settings.searchQuery = value.trim();
					await this.plugin.saveSettings();
					this.triggerUpdate({ redrawData: true });
				}, 500, true)));

		new Setting(containerEl).setName('Show neighboring nodes')
			.setDesc('Also show the nodes linked to the search results.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.showNeighboringNodes)
				.onChange(async (value) => {
					this.plugin.settings.showNeighboringNodes = value;
					await this.plugin.saveSettings();
					if (this.plugin.settings.searchQuery) {
						this.triggerUpdate({ redrawData: true });
					}
				}));

		containerEl.createEl('h3', { text: 'Filters' });
		new Setting(containerEl).setName('Show tags').addToggle(toggle => toggle.setValue(this.plugin.settings.showTags)
			.onChange(async (value) => { this.plugin.settings.showTags = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true }); }));
		new Setting(containerEl).setName('Show attachments').addToggle(toggle => toggle.setValue(this.plugin.settings.showAttachments)
			.onChange(async (value) => { this.plugin.settings.showAttachments = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true }); }));
		new Setting(containerEl).setName('Hide orphans').addToggle(toggle => toggle.setValue(this.plugin.settings.hideOrphans)
			.onChange(async (value) => { this.plugin.settings.hideOrphans = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true }); }));

		containerEl.createEl('h3', { text: 'Groups' });
		containerEl.createEl('p', { text: 'Color nodes with custom rules. Use "path:", "tag:", "file:", or text match. Examples: path:folder, tag:#project, file:MyNote.md, file:*.pdf', cls: 'setting-item-description' });

		this.plugin.settings.groups.forEach((group, index) => {
			new Setting(containerEl)
				.addText(text => text
					.setPlaceholder('path:, tag:, file:, or text')
					.setValue(group.query)
					.onChange(async (value) => {
						group.query = value;
						await this.plugin.saveSettings();
						this.triggerUpdate({ updateDisplay: true });
					}))
				.addColorPicker(color => color
					.setValue(group.color)
					.onChange(async (value) => {
						group.color = value;
						await this.plugin.saveSettings();
						this.triggerUpdate({ updateDisplay: true });
					}))
				.addExtraButton(button => button
					.setIcon('cross')
					.setTooltip('Remove group')
					.onClick(async () => {
						this.plugin.settings.groups.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
						this.triggerUpdate({ updateDisplay: true });
					}));
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add new group')
				.onClick(async () => {
					this.plugin.settings.groups.push({ query: '', color: '#ffffff' });
					await this.plugin.saveSettings();
					this.display();
				}));

		containerEl.createEl('h3', { text: 'Display' });
		new Setting(containerEl).setName('Use theme colors').setDesc('Automatically use your current Obsidian theme colors for the graph.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.useThemeColors)
				.onChange(async (value) => {this.plugin.settings.useThemeColors = value; await this.plugin.saveSettings(); this.display(); this.triggerUpdate({ updateDisplay: true }); }));

		if (!this.plugin.settings.useThemeColors) {
			new Setting(containerEl).setName('Node color').addColorPicker(c => c.setValue(this.plugin.settings.colorNode).onChange(async (v) => { this.plugin.settings.colorNode = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
			new Setting(containerEl).setName('Tag color').addColorPicker(c => c.setValue(this.plugin.settings.colorTag).onChange(async (v) => { this.plugin.settings.colorTag = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
			new Setting(containerEl).setName('Attachment color').addColorPicker(c => c.setValue(this.plugin.settings.colorAttachment).onChange(async (v) => { this.plugin.settings.colorAttachment = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
			new Setting(containerEl).setName('Link color').addColorPicker(c => c.setValue(this.plugin.settings.colorLink).onChange(async (v) => { this.plugin.settings.colorLink = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
			new Setting(containerEl).setName('Highlight color').addColorPicker(c => c.setValue(this.plugin.settings.colorHighlight).onChange(async (v) => { this.plugin.settings.colorHighlight = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
			new Setting(containerEl).setName('Background color').addColorPicker(c => c.setValue(this.plugin.settings.backgroundColor).onChange(async (v) => { this.plugin.settings.backgroundColor = v; await this.plugin.saveSettings(); this.triggerUpdate({}); }));
		}

		containerEl.createEl('h3', { text: 'Appearance' });
		new Setting(containerEl).setName('Node shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.plugin.settings.nodeShape)
			.onChange(async(value: NodeShape) => {this.plugin.settings.nodeShape = value; await this.plugin.saveSettings(); this.triggerUpdate({updateDisplay: true})}));
		new Setting(containerEl).setName('Tag shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.plugin.settings.tagShape)
			.onChange(async(value: NodeShape) => {this.plugin.settings.tagShape = value; await this.plugin.saveSettings(); this.triggerUpdate({updateDisplay: true})}));
		new Setting(containerEl).setName('Attachment shape').addDropdown(dd => dd.addOptions(NodeShape).setValue(this.plugin.settings.attachmentShape)
			.onChange(async(value: NodeShape) => {this.plugin.settings.attachmentShape = value; await this.plugin.saveSettings(); this.triggerUpdate({updateDisplay: true})}));
		new Setting(containerEl).setName('Node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.nodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.nodeSize = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
		new Setting(containerEl).setName('Tag node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.tagNodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.tagNodeSize = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
		new Setting(containerEl).setName('Attachment node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.attachmentNodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.attachmentNodeSize = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
		new Setting(containerEl).setName('Link thickness').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.linkThickness).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.linkThickness = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));

		containerEl.createEl('h3', { text: 'Interaction' });
		new Setting(containerEl).setName("Zoom on click").setDesc("Automatically zoom in on a node when it's clicked.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.zoomOnClick)
				.onChange(async (value) => {this.plugin.settings.zoomOnClick = value; await this.plugin.saveSettings();}));
		new Setting(containerEl).setName('Rotation Speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.rotateSpeed).setDynamicTooltip()
			.onChange(async (v) => {this.plugin.settings.rotateSpeed = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateForces: true });}));
		new Setting(containerEl).setName('Pan Speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.panSpeed).setDynamicTooltip()
			.onChange(async (v) => {this.plugin.settings.panSpeed = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateForces: true });}));
		new Setting(containerEl).setName('Zoom Speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.zoomSpeed).setDynamicTooltip()
			.onChange(async (v) => {this.plugin.settings.zoomSpeed = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateForces: true });}));

		containerEl.createEl('h3', { text: 'Forces' });
		new Setting(containerEl).setName('Center force').setDesc('How strongly nodes are pulled toward the center.')
			.addSlider(s => s.setLimits(0, 1, 0.01).setValue(this.plugin.settings.centerForce).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.centerForce = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateForces: true }); }));
		new Setting(containerEl).setName('Repel force').setDesc('How strongly nodes push each other apart.')
			.addSlider(s => s.setLimits(0, 20, 0.1).setValue(this.plugin.settings.repelForce).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.repelForce = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateForces: true }); }));
		new Setting(containerEl).setName('Link force').setDesc('How strongly links pull nodes together.')
			.addSlider(s => s.setLimits(0, 0.1, 0.001).setValue(this.plugin.settings.linkForce).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.linkForce = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateForces: true }); }));
	}
}

export default class Graph3DPlugin extends Plugin {
	settings: Graph3DPluginSettings;
	async onload() {
		await this.loadSettings();
		this.registerView(VIEW_TYPE_3D_GRAPH, (leaf) => new Graph3DView(leaf, this));
		this.addSettingTab(new Graph3DSettingsTab(this.app, this));
		this.addRibbonIcon("network", "Open 3D Graph", () => this.activateView());

		this.addCommand({
			id: 'open-3d-graph-view',
			name: 'Open 3D Graph',
			callback: () => {
				this.activateView();
			}
		});

		const debouncedUpdate = debounce(() => this.triggerLiveUpdate(), 300, true);
		this.registerEvent(this.app.vault.on('create', debouncedUpdate));
		this.registerEvent(this.app.vault.on('delete', debouncedUpdate));
		this.registerEvent(this.app.vault.on('modify', debouncedUpdate));
		this.registerEvent(this.app.metadataCache.on('resolve', debouncedUpdate));

	}

	triggerLiveUpdate() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH).forEach(leaf => {
			if (leaf.view instanceof Graph3DView) {
				leaf.view.updateData();
			}
		});
	}

	onunload() {
	}

	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }

	async activateView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH);
		if (leaves.length > 0) {
			this.app.workspace.revealLeaf(leaves[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_3D_GRAPH, active: true });
		this.app.workspace.revealLeaf(leaf);
	}
}
