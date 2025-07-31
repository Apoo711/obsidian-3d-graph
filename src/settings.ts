// src/settings.ts
import { App, PluginSettingTab, Setting, debounce } from 'obsidian';
import Graph3DPlugin from '../main';
import { NodeShape } from './types';
import { Graph3DView, VIEW_TYPE_3D_GRAPH } from './view';

export class Graph3DSettingsTab extends PluginSettingTab {
	plugin: Graph3DPlugin;
	constructor(app: App, plugin: Graph3DPlugin) { super(app, plugin); this.plugin = plugin; }

	private triggerUpdate(options: { redrawData?: boolean, useCache?: boolean, reheat?: boolean, updateDisplay?: boolean, updateControls?: boolean }) {
		this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH).forEach(leaf => {
			if (leaf.view instanceof Graph3DView) {
				if (leaf.view.isSettingsPanelOpen()) {
					leaf.view.renderSettingsPanel();
				}

				if (options.redrawData) {
					// Pass cache and reheat options through
					leaf.view.updateData({ useCache: options.useCache, reheat: options.reheat });
				} else if (options.updateDisplay) {
					leaf.view.updateDisplay();
					leaf.view.updateColors();
				} else if (options.updateControls) {
					leaf.view.updateControls();
				} else {
					leaf.view.updateColors();
				}
			}
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Search').setHeading();
		new Setting(containerEl).setName('Search term').setDesc('Only show notes containing this text.')
			.addText(text => text.setPlaceholder('Enter search term...')
				.setValue(this.plugin.settings.searchQuery)
				.onChange(debounce(async (value) => {
					this.plugin.settings.searchQuery = value.trim();
					await this.plugin.saveSettings();
					this.triggerUpdate({ redrawData: true, useCache: true });
				}, 500, true)));

		new Setting(containerEl).setName('Show neighboring nodes')
			.setDesc('Also show the nodes linked to the search results.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.showNeighboringNodes)
				.onChange(async (value) => {
					this.plugin.settings.showNeighboringNodes = value;
					await this.plugin.saveSettings();
					if (this.plugin.settings.searchQuery) {
						this.triggerUpdate({ redrawData: true, useCache: true });
					}
				}));

		new Setting(containerEl).setName('Filters').setHeading();
		new Setting(containerEl).setName('Show tags').addToggle(toggle => toggle.setValue(this.plugin.settings.showTags)
			.onChange(async (value) => { this.plugin.settings.showTags = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true, useCache: true }); }));
		new Setting(containerEl).setName('Show attachments').addToggle(toggle => toggle.setValue(this.plugin.settings.showAttachments)
			.onChange(async (value) => { this.plugin.settings.showAttachments = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true, useCache: true }); }));
		new Setting(containerEl).setName('Hide orphans').addToggle(toggle => toggle.setValue(this.plugin.settings.hideOrphans)
			.onChange(async (value) => { this.plugin.settings.hideOrphans = value; await this.plugin.saveSettings(); this.triggerUpdate({ redrawData: true, useCache: true }); }));

		new Setting(containerEl).setName('Groups').setHeading();
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

		new Setting(containerEl).setName('Display').setHeading();
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

		new Setting(containerEl).setName('Appearance').setHeading();
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

		new Setting(containerEl).setName('Labels').setHeading();
		new Setting(containerEl).setName('Show node labels').setDesc('Display the name of the node as a label.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.showNodeLabels)
				.onChange(async (value) => { this.plugin.settings.showNodeLabels = value; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
		new Setting(containerEl).setName('Label distance').setDesc('How far away the camera can be before labels start to fade.')
			.addSlider(s => s.setLimits(50, 500, 10).setValue(this.plugin.settings.labelDistance).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.labelDistance = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Label fade threshold').setDesc('The distance at which labels start to fade, as a percentage of the total label distance.')
			.addSlider(s => s.setLimits(0.1, 1, 0.1).setValue(this.plugin.settings.labelFadeThreshold).setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.labelFadeThreshold = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Label text size').addSlider(s => s.setLimits(1, 10, 0.5).setValue(this.plugin.settings.labelTextSize).setDynamicTooltip()
			.onChange(async (v) => { this.plugin.settings.labelTextSize = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));
		new Setting(containerEl).setName('Label text color').addColorPicker(c => c.setValue(this.plugin.settings.labelTextColor).onChange(async (v) => { this.plugin.settings.labelTextColor = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateDisplay: true }); }));


		new Setting(containerEl).setName('Interaction').setHeading();
		new Setting(containerEl).setName("Zoom on click").setDesc("Automatically zoom in on a node when it's clicked.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.zoomOnClick)
				.onChange(async (value) => {this.plugin.settings.zoomOnClick = value; await this.plugin.saveSettings();}));
		new Setting(containerEl).setName('Rotation speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.rotateSpeed).setDynamicTooltip()
			.onChange(async (v) => {this.plugin.settings.rotateSpeed = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateControls: true });}));
		new Setting(containerEl).setName('Pan speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.panSpeed).setDynamicTooltip()
			.onChange(async (v) => {this.plugin.settings.panSpeed = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateControls: true });}));
		new Setting(containerEl).setName('Zoom speed').addSlider(s => s.setLimits(0.1, 5, 0.1).setValue(this.plugin.settings.zoomSpeed).setDynamicTooltip()
			.onChange(async (v) => {this.plugin.settings.zoomSpeed = v; await this.plugin.saveSettings(); this.triggerUpdate({ updateControls: true });}));

		new Setting(containerEl).setName('Forces').setHeading();
		const forceSettingHandler = async (value: number, setting: 'centerForce' | 'repelForce' | 'linkForce') => {
			this.plugin.settings[setting] = value;
			await this.plugin.saveSettings();
			this.triggerUpdate({ redrawData: true, useCache: false, reheat: true });
		};

		new Setting(containerEl).setName('Center force').setDesc('How strongly nodes are pulled toward the center.')
			.addSlider(s => s.setLimits(0, 1, 0.01).setValue(this.plugin.settings.centerForce).setDynamicTooltip()
				.onChange(async (v) => { await forceSettingHandler(v, 'centerForce'); }));
		new Setting(containerEl).setName('Repel force').setDesc('How strongly nodes push each other apart.')
			.addSlider(s => s.setLimits(0, 20, 0.1).setValue(this.plugin.settings.repelForce).setDynamicTooltip()
				.onChange(async (v) => { await forceSettingHandler(v, 'repelForce'); }));
		new Setting(containerEl).setName('Link force').setDesc('How strongly links pull nodes together.')
			.addSlider(s => s.setLimits(0, 0.1, 0.001).setValue(this.plugin.settings.linkForce).setDynamicTooltip()
				.onChange(async (v) => { await forceSettingHandler(v, 'linkForce'); }));
	}
}
