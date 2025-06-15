// main.ts
import { App, ItemView, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';


export const VIEW_TYPE_3D_GRAPH = "3d-graph-view";

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
}

const DEFAULT_SETTINGS: Graph3DPluginSettings = {
	showAttachments: false,
	hideOrphans: false,
	showTags: false,
	searchQuery: '',
	groups: [],
	colorNode: '#1e90ff',
	colorTag: '#da70d6',
	colorAttachment: '#9acd32',
	colorLink: '#333333',
	colorHighlight: '#ff8c00',
	backgroundColor: '#000011',
	nodeSize: 1.5,
	tagNodeSize: 1.0,
	attachmentNodeSize: 1.2,
	linkThickness: 1,
	centerForce: 0.1,
	repelForce: 10,
	linkForce: 0.01,
	nodeShape: NodeShape.Sphere,
	tagShape: NodeShape.Tetrahedron,
	attachmentShape: NodeShape.Cube
};

enum NodeType { File, Tag, Attachment }
interface GraphNode {
	id: string;
	name: string;
	type: NodeType;
	tags?: string[];
}

class Graph3DView extends ItemView {
	private graph: any;
	private plugin: Graph3DPlugin;
	private settings: Graph3DPluginSettings;

	private highlightedNodes = new Set<string>();
	private highlightedLinks = new Set<object>();
	private selectedNode: string | null = null;

	private graphContainer: HTMLDivElement;
	private messageEl: HTMLDivElement;
	private clickTimeout: any = null;
	private readonly CLICK_DELAY = 250;

	constructor(leaf: WorkspaceLeaf, plugin: Graph3DPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settings = plugin.settings;
	}

	getViewType() { return VIEW_TYPE_3D_GRAPH; }
	getDisplayText() { return "3D Graph"; }

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		this.graphContainer = container.createEl('div', { attr: { style: 'position: relative; width: 100%; height: 100%;' } });
		this.initializeGraph();
	}

	initializeGraph() {
		this.app.workspace.onLayoutReady(() => {
			this.graphContainer.empty();

			this.messageEl = this.graphContainer.createEl('div', {
				attr: {
					style: 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: grey; display: none; z-index: 10;'
				}
			});

			const Graph = (ForceGraph3D as any).default || ForceGraph3D;
			this.graph = Graph()(this.graphContainer)
				.onNodeClick((node: GraphNode) => this.handleNodeClick(node));

			const placeholderData = {
				nodes: [{ id: 'loading', name: 'Loading graph...', type: NodeType.File, val: 5 }],
				links: []
			};
			this.graph.graphData(placeholderData);
			this.updateColors();

			setTimeout(() => {
				this.graph.pauseAnimation();
				this.updateAll();
				this.graph.resumeAnimation();
			}, 100);
		});
	}

	public updateAll() {
		this.updateData();
		this.updateDisplay();
		this.updateColors();
		this.updateForces();
	}

	public updateData() {
		if (!this.graph) return;
		const newData = this.processVaultData();
		const hasNodes = newData && newData.nodes.length > 0;

		this.graph.graphData(newData || { nodes: [], links: [] });

		if (hasNodes) {
			this.messageEl.style.display = 'none';
		} else {
			this.messageEl.setText("No files to display based on current filters.");
			this.messageEl.style.display = 'block';
		}
	}

	public updateColors() {
		if (!this.graph) return;
		this.graph.backgroundColor(this.settings.backgroundColor);

		this.graph.graphData().nodes.forEach((node: any) => {
			if (node.__threeObj) {
				const color = this.getNodeColor(node);
				(node.__threeObj as THREE.Mesh).material.color.set(color);
			}
		});
		this.graph.linkColor(link => this.highlightedLinks.has(link) ? this.settings.colorHighlight : this.settings.colorLink);
	}

	private getNodeColor(node: GraphNode): string {
		if (this.highlightedNodes.has(node.id)) return this.settings.colorHighlight;
		for (const group of this.settings.groups) {
			const query = group.query.toLowerCase();
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
			} else if (query) {
				if (node.id.toLowerCase().includes(query)) {
					return group.color;
				}
			}
		}
		if (node.type === NodeType.Tag) return this.settings.colorTag;
		if (node.type === NodeType.Attachment) return this.settings.colorAttachment;
		return this.settings.colorNode;
	}

	public updateDisplay() {
		if (!this.graph) return;
		this.graph
			.nodeLabel('name')
			.nodeThreeObject((node: GraphNode) => this.createNodeObject(node))
			.linkWidth(link => this.highlightedLinks.has(link) ? (this.settings.linkThickness * 1.5) : this.settings.linkThickness);
	}

	private createNodeObject(node: GraphNode): THREE.Object3D {
		let shape;
		let size;
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
			case NodeShape.Sphere:
			default:
				geometry = new THREE.SphereGeometry(s / 2);
				break;
		}

		const material = new THREE.MeshLambertMaterial({
			color: this.getNodeColor(node),
			transparent: true,
			opacity: 0.9
		});

		return new THREE.Mesh(geometry, material);
	}


	public updateForces() {
		if (!this.graph) return;

		if (this.graph.graphData().nodes.length > 0) {
			const { centerForce, repelForce, linkForce } = this.settings;
			const forceSim = this.graph.d3Force;

			if (forceSim) {
				if (forceSim('center')) forceSim('center').strength(centerForce);
				if (forceSim('charge')) forceSim('charge').strength(-repelForce);
				if (forceSim('link')) forceSim('link').strength(linkForce);
			}
			this.graph.d3ReheatSimulation();
		} else {
			this.graph.pauseAnimation();
		}
	}

	private handleNodeClick(node: GraphNode) {
		if (!node || !this.graph || node.id === 'loading') return;
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
			const { links } = this.graph.graphData();
			links.forEach((link: any) => {
				if (link.source?.id === node.id) {
					this.highlightedNodes.add(link.target.id);
					this.highlightedLinks.add(link);
				} else if (link.target?.id === node.id) {
					this.highlightedNodes.add(link.source.id);
					this.highlightedLinks.add(link);
				}
			});
			if ((node as any).__threeObj) {
				const distance = 100;
				const nodePosition = (node as any).__threeObj.position;
				this.graph.cameraPosition({ x: nodePosition.x, y: nodePosition.y, z: nodePosition.z + distance }, nodePosition, 1000);
			}
		}
		this.updateColors();
	}

	private processVaultData(): { nodes: GraphNode[], links: { source: string, target: string }[] } | null {
		const { showAttachments, hideOrphans, showTags, searchQuery } = this.settings;
		const files = this.app.vault.getFiles();
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		if (!resolvedLinks) return null;

		let nodes: GraphNode[] = files
			.filter(file => showAttachments || file.extension === 'md')
			.map(file => {
				const cache = this.app.metadataCache.getFileCache(file);
				const tags = cache?.tags?.map(t => t.tag.substring(1)) || [];
				const type = file.extension === 'md' ? NodeType.File : NodeType.Attachment;
				return { id: file.path, name: file.basename, type: type, tags };
			});

		const filePaths = new Set(nodes.map(n => n.id));
		let links: { source: string, target: string }[] = [];
		for (const sourcePath in resolvedLinks) {
			if (!filePaths.has(sourcePath)) continue;
			for (const targetPath in resolvedLinks[sourcePath]) {
				const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
				if (targetFile) links.push({ source: sourcePath, target: targetPath });
			}
		}

		if (showTags) {
			const allTags = new Map<string, GraphNode>();
			nodes.forEach(node => {
				if (node.type === NodeType.File && node.tags) {
					node.tags.forEach(tagName => {
						const tagId = `tag:${tagName}`;
						if (!allTags.has(tagName)) {
							allTags.set(tagName, { id: tagId, name: `#${tagName}`, type: NodeType.Tag });
						}
						links.push({ source: node.id, target: tagId });
					});
				}
			});
			nodes.push(...allTags.values());
		}

		if (hideOrphans) {
			const linkedNodeIds = new Set<string>();
			links.forEach(link => { linkedNodeIds.add(link.source); linkedNodeIds.add(link.target); });
			nodes = nodes.filter(node => linkedNodeIds.has(node.id));
		}

		if (searchQuery) {
			const filteredNodeIds = new Set<string>();
			const lowerCaseFilter = searchQuery.toLowerCase();
			nodes.forEach(node => {
				if (node.name.toLowerCase().includes(lowerCaseFilter) ||
					(node.type !== NodeType.Tag && node.id.toLowerCase().includes(lowerCaseFilter))) {
					filteredNodeIds.add(node.id);
				}
			});
			links.forEach(link => {
				if (filteredNodeIds.has(link.source)) filteredNodeIds.add(link.target);
				if (filteredNodeIds.has(link.target)) filteredNodeIds.add(link.source);
			});
			nodes = nodes.filter(node => filteredNodeIds.has(node.id));
		}

		const finalNodeIds = new Set(nodes.map(n => n.id));
		links = links.filter(link => finalNodeIds.has(link.source) && finalNodeIds.has(link.target));

		return { nodes, links };
	}

	async onClose() {
		if (this.clickTimeout) clearTimeout(this.clickTimeout);
		if (this.graph) {
			this.graph.pauseAnimation();
			const renderer = this.graph.renderer();
			if (renderer?.domElement) {
				renderer.forceContextLoss();
				renderer.dispose();
			}
			this.graph._destructor();
			this.graph = null;
		}
		this.messageEl?.remove();
		this.graphContainer?.empty();
	}
}

class Graph3DSettingsTab extends PluginSettingTab {
	plugin: Graph3DPlugin;
	constructor(app: App, plugin: Graph3DPlugin) { super(app, plugin); this.plugin = plugin; }

	private triggerUpdate(options: { redrawData: boolean, updateForces: boolean }) {
		this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH).forEach(leaf => {
			if (leaf.view instanceof Graph3DView) {
				if (options.redrawData) { leaf.view.updateData(); }
				leaf.view.updateColors();
				leaf.view.updateDisplay();
				if (options.updateForces) { leaf.view.updateForces(); }
			}
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: '3D Graph Settings' });

		containerEl.createEl('h3', { text: 'Search' });
		new Setting(containerEl).setName('Search term').setDesc('Only show notes containing this text, plus their neighbors.')
			.addText(text => text.setPlaceholder('Enter search term...').setValue(this.plugin.settings.searchQuery)
				.onChange(async (value) => { this.plugin.settings.searchQuery = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true, updateForces: true }); }));

		containerEl.createEl('h3', { text: 'Filters' });
		new Setting(containerEl).setName('Show tags').addToggle(toggle => toggle.setValue(this.plugin.settings.showTags)
			.onChange(async (value) => { this.plugin.settings.showTags = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true, updateForces: true }); }));
		new Setting(containerEl).setName('Show attachments').addToggle(toggle => toggle.setValue(this.plugin.settings.showAttachments)
			.onChange(async (value) => { this.plugin.settings.showAttachments = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true, updateForces: true }); }));
		new Setting(containerEl).setName('Hide orphans').addToggle(toggle => toggle.setValue(this.plugin.settings.hideOrphans)
			.onChange(async (value) => { this.plugin.settings.hideOrphans = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true, updateForces: true }); }));

		containerEl.createEl('h3', { text: 'Color Groups' });
		this.plugin.settings.groups.forEach((group, index) => {
			new Setting(containerEl).addSearch(cb => { cb.setPlaceholder('path:folder OR tag:my-tag').setValue(group.query)
				.onChange(async (value) => { group.query = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); });
			}).addColorPicker(cb => { cb.setValue(group.color)
				.onChange(async (value) => { group.color = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); });
			}).addExtraButton(cb => { cb.setIcon('cross').setTooltip('Delete group').onClick(async () => {
				this.plugin.settings.groups.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
				this.triggerUpdate({ redrawData: false, updateForces: false });
			});
			});
		});
		new Setting(containerEl).addButton(btn => btn.setButtonText('New group').onClick(async () => {
			this.plugin.settings.groups.push({ query: '', color: '#ffffff' });
			await this.plugin.saveSettings(); this.display();
		}));

		containerEl.createEl('h3', { text: 'Display' });

		new Setting(containerEl).setName('Node shape')
			.addDropdown(dd => dd.addOptions(NodeShape).setValue(this.plugin.settings.nodeShape)
				.onChange(async(value: NodeShape) => {this.plugin.settings.nodeShape = value; await this.plugin.saveSettings(); this.triggerUpdate({redrawData: false, updateForces: false})}));

		new Setting(containerEl).setName('Tag shape')
			.addDropdown(dd => dd.addOptions(NodeShape).setValue(this.plugin.settings.tagShape)
				.onChange(async(value: NodeShape) => {this.plugin.settings.tagShape = value; await this.plugin.saveSettings(); this.triggerUpdate({redrawData: false, updateForces: false})}));

		new Setting(containerEl).setName('Attachment shape')
			.addDropdown(dd => dd.addOptions(NodeShape).setValue(this.plugin.settings.attachmentShape)
				.onChange(async(value: NodeShape) => {this.plugin.settings.attachmentShape = value; await this.plugin.saveSettings(); this.triggerUpdate({redrawData: false, updateForces: false})}));

		new Setting(containerEl).setName('Node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.nodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.nodeSize = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Tag node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.tagNodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.tagNodeSize = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Attachment node size').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.attachmentNodeSize).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.attachmentNodeSize = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Link thickness').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.linkThickness).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.linkThickness = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Node color').addColorPicker(c => c.setValue(this.plugin.settings.colorNode)
			.onChange(async (v) => { this.plugin.settings.colorNode = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Tag color').addColorPicker(c => c.setValue(this.plugin.settings.colorTag)
			.onChange(async (v) => { this.plugin.settings.colorTag = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Attachment color').addColorPicker(c => c.setValue(this.plugin.settings.colorAttachment)
			.onChange(async (v) => { this.plugin.settings.colorAttachment = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Link color').addColorPicker(c => c.setValue(this.plugin.settings.colorLink)
			.onChange(async (v) => { this.plugin.settings.colorLink = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Highlight color').addColorPicker(c => c.setValue(this.plugin.settings.colorHighlight)
			.onChange(async (v) => { this.plugin.settings.colorHighlight = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));
		new Setting(containerEl).setName('Background color').addColorPicker(c => c.setValue(this.plugin.settings.backgroundColor)
			.onChange(async (v) => { this.plugin.settings.backgroundColor = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: false }); }));

		containerEl.createEl('h3', { text: 'Forces' });
		new Setting(containerEl).setName('Center force').setDesc('How strongly nodes are pulled toward the center.')
			.addSlider(s => s.setLimits(0, 1, 0.01).setValue(this.plugin.settings.centerForce).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.centerForce = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: true }); }));
		new Setting(containerEl).setName('Repel force').setDesc('How strongly nodes push each other apart.')
			.addSlider(s => s.setLimits(0, 20, 0.1).setValue(this.plugin.settings.repelForce).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.repelForce = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: true }); }));
		new Setting(containerEl).setName('Link force').setDesc('How strongly links pull nodes together.')
			.addSlider(s => s.setLimits(0, 0.1, 0.001).setValue(this.plugin.settings.linkForce).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.linkForce = v; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: false, updateForces: true }); }));
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
	}
	onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE_3D_GRAPH); }
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
