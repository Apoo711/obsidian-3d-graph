// main.ts
import { App, ItemView, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';

// We declare the type for the library which will be loaded onto the window object.
declare const ForceGraph3D: any;

export const VIEW_TYPE_3D_GRAPH = "3d-graph-view";

// --- Define the structure of our plugin's settings ---
interface Graph3DPluginSettings {
	showAttachments: boolean;
	hideOrphans: boolean; // NEW SETTING
}

// --- Define the default settings ---
const DEFAULT_SETTINGS: Graph3DPluginSettings = {
	showAttachments: false,
	hideOrphans: false // NEW SETTING
};

class Graph3DView extends ItemView {
	private graph: any;
	private plugin: Graph3DPlugin;
	private settings: Graph3DPluginSettings;

	private highlightedNodes = new Set<string>();
	private highlightedLinks = new Set<object>();
	private selectedNode: string | null = null;

	private graphContainer: HTMLDivElement;
	private clickTimeout: any = null;
	private readonly CLICK_DELAY = 250; // ms

	constructor(leaf: WorkspaceLeaf, plugin: Graph3DPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settings = plugin.settings;
	}

	getViewType() {
		return VIEW_TYPE_3D_GRAPH;
	}

	getDisplayText() {
		return "3D Graph";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		this.graphContainer = container.createEl('div');
		this.graphContainer.style.width = '100%';
		this.graphContainer.style.height = '100%';
		this.graphContainer.createEl("h4", { text: "Loading 3D Graph library..." });

		this.loadScriptAndInitialize();
	}

	loadScriptAndInitialize() {
		if (document.getElementById('3d-force-graph-script')) {
			this.initializeGraph();
			return;
		}

		const script = document.createElement('script');
		script.id = '3d-force-graph-script';
		script.src = 'https://unpkg.com/3d-force-graph';

		script.onload = () => this.initializeGraph();
		script.onerror = () => {
			this.graphContainer.empty();
			this.graphContainer.createEl("h4", { text: "Error: Could not load library." });
		};

		document.body.appendChild(script);
	}

	initializeGraph() {
		this.app.workspace.onLayoutReady(() => {
			this.graphContainer.empty();
			const graphData = this.processVaultData();

			if (!graphData || graphData.nodes.length === 0) {
				this.graphContainer.createEl("h4", { text: "No connected files to display." });
				return;
			}

			this.graph = ForceGraph3D()
			(this.graphContainer)
				.graphData(graphData)
				.nodeLabel('name')
				.nodeVal(node => 1.5)
				.nodeColor(node => this.highlightedNodes.has(node.id as string) ? (node.id === this.selectedNode ? 'yellow' : 'orange') : 'dodgerblue')
				.linkColor(link => this.highlightedLinks.has(link) ? 'red' : '#333333')
				.linkWidth(link => this.highlightedLinks.has(link) ? 2 : 1)
				.onNodeClick(this.handleNodeClick.bind(this));

			this.graph.width(this.graphContainer.offsetWidth);
			this.graph.height(this.graphContainer.offsetHeight);
		});
	}

	public redrawGraph() {
		console.log("3D-Graph: Settings updated, redrawing graph.");
		if (this.graph) {
			const newData = this.processVaultData();
			this.graph.graphData(newData);
		}
	}

	private handleNodeClick(node: any) {
		if (!node || !this.graph) return;

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

	private handleNodeDoubleClick(node: any) {
		const file = this.app.vault.getAbstractFileByPath(node.id as string);
		if (file instanceof TFile) {
			this.app.workspace.getLeaf('tab').openFile(file);
		}
	}

	private handleNodeSingleClick(node: any) {
		if (this.selectedNode === node.id) {
			this.selectedNode = null;
			this.highlightedNodes.clear();
			this.highlightedLinks.clear();
		} else {
			this.selectedNode = node.id as string;
			this.highlightedNodes.clear();
			this.highlightedLinks.clear();

			this.highlightedNodes.add(node.id as string);

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

			if (node.__threeObj) {
				const distance = 100;
				const nodePosition = node.__threeObj.position;
				this.graph.cameraPosition(
					{ x: nodePosition.x, y: nodePosition.y, z: nodePosition.z + distance },
					nodePosition,
					1000
				);
			}
		}
		this.graph.nodeColor(this.graph.nodeColor()).linkColor(this.graph.linkColor()).linkWidth(this.graph.linkWidth());
	}

	// --- MODIFIED: This function now handles filtering orphans ---
	private processVaultData() {
		const { showAttachments, hideOrphans } = this.settings;
		console.log(`3D-Graph: Settings: showAttachments=${showAttachments}, hideOrphans=${hideOrphans}`);

		const files = showAttachments
			? this.app.vault.getFiles()
			: this.app.vault.getMarkdownFiles();

		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		if (!resolvedLinks) { return { nodes: [], links: [] }; }

		const filePaths = new Set(files.map(f => f.path));
		let nodes = files.map(file => ({ id: file.path, name: file.basename }));

		const links: { source: string, target: string }[] = [];
		for (const sourcePath in resolvedLinks) {
			if (!filePaths.has(sourcePath)) continue;
			for (const targetPath in resolvedLinks[sourcePath]) {
				if (!filePaths.has(targetPath)) continue;
				links.push({ source: sourcePath, target: targetPath });
			}
		}

		// --- NEW: Orphan filtering logic ---
		if (hideOrphans) {
			const linkedNodes = new Set<string>();
			links.forEach(link => {
				linkedNodes.add(link.source);
				linkedNodes.add(link.target);
			});
			nodes = nodes.filter(node => linkedNodes.has(node.id as string));
		}

		console.log(`3D-Graph: Found ${nodes.length} nodes and ${links.length} links.`);
		return { nodes, links };
	}

	async onClose() {
		console.log("3D-Graph: Closing view and cleaning up WebGL context.");
		if (this.clickTimeout) {
			clearTimeout(this.clickTimeout);
		}

		if (this.graph) {
			this.graph.pauseAnimation();
			const renderer = this.graph.renderer();
			if (renderer && renderer.domElement) {
				renderer.forceContextLoss();
				renderer.dispose();
			}
			this.graph._destructor();
			this.graph = null;
		}
		this.graphContainer?.empty();
	}
}

class Graph3DSettingsTab extends PluginSettingTab {
	plugin: Graph3DPlugin;

	constructor(app: App, plugin: Graph3DPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: '3D Graph Settings' });

		new Setting(containerEl)
			.setName('Show attachments')
			.setDesc('Include attachments (images, PDFs, etc.) in the graph.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showAttachments)
				.onChange(async (value) => {
					this.plugin.settings.showAttachments = value;
					await this.plugin.saveSettings();
				}));

		// --- NEW: Toggle for hiding orphans ---
		new Setting(containerEl)
			.setName('Hide orphans')
			.setDesc('Do not show notes that have no links.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideOrphans)
				.onChange(async (value) => {
					this.plugin.settings.hideOrphans = value;
					await this.plugin.saveSettings();
				}));
	}
}

export default class Graph3DPlugin extends Plugin {
	settings: Graph3DPluginSettings;

	async onload() {
		console.log("Loading 3D Graph Plugin");
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_3D_GRAPH,
			(leaf) => new Graph3DView(leaf, this)
		);

		this.addSettingTab(new Graph3DSettingsTab(this.app, this));
		this.addRibbonIcon("network", "Open 3D Graph", () => this.activateView());
	}

	onunload() {
		console.log("Unloading 3D Graph Plugin");
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_3D_GRAPH);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH).forEach(leaf => {
			if (leaf.view instanceof Graph3DView) {
				leaf.view.redrawGraph();
			}
		});
	}

	async activateView() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_3D_GRAPH);
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_3D_GRAPH,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf);
	}
}
