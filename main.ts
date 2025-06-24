// main.ts
import { Plugin, debounce } from 'obsidian';
import { Graph3DPluginSettings, DEFAULT_SETTINGS } from './src/types';
import { Graph3DView, VIEW_TYPE_3D_GRAPH } from './src/view';
import { Graph3DSettingsTab } from './src/settings';

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

		// Debounced update for live changes in the vault
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

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

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
