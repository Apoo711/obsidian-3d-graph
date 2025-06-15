# 3D Graph for Obsidian

A plugin for Obsidian that provides a highly customizable 3D, force-directed graph view of your vault. This offers an alternative, immersive way to visualize and explore the connections between your notes.

![img.png](assets/img.png)

## Features

* **Interactive 3D Canvas:** Pan, zoom, and rotate around your notes to explore their relationships from any angle.

* **Node Interaction:**

	* **Single-click** on a node to focus the camera on it and highlight its immediate connections.

	* **Double-click** on a file or attachment node to open it in a new tab.

* **Advanced Filtering & Search:**

	* **Search:** A powerful search bar to find specific notes and their neighbors.

	* **Live Filters:** Toggle visibility for attachments, tags, and orphan nodes on the fly.

* **Deep Customization:**

	* **Color Groups:** Create rules to color-code your graph based on file paths (`path:`) or tags (`tag:`), just like the native graph.

	* **Node Appearance:** Independently control the shape, size, and color for notes, attachments, and tags.

	* **Physics Engine:** Fine-tune the graph's layout with sliders for Center force, Repel force, and Link force.

* **Stable & Performant:**

	* Now uses `npm` packages for reliable offline performance.

	* All settings update the graph instantly without requiring a reload.

## How to Install

1. Download `main.js` and `manifest.json` from the latest [release](https://github.com/Apoo711/obsidian-3d-graph/releases).

2. In Obsidian, open `Settings` > `Community plugins`.

3. Make sure "Restricted mode" is turned off.

4. Open your vault's plugin folder by clicking the small folder icon next to "Installed plugins".

5. Create a new folder named `3d-graph-plugin`.

6. Copy the downloaded `main.js` and `manifest.json` files into this new folder.

7. Go back to Obsidian's "Community plugins" settings and click the refresh button.

8. Enable "3D Graph Plugin".

Once enabled, you can open the 3D Graph from the ribbon icon on the left sidebar or by using the Command Palette (`Ctrl/Cmd + P` and typing "Open 3D Graph").

## Settings

You can configure the 3D Graph by going to `Settings` > `3D Graph Plugin`. All settings are applied live.

* **Search:** Filter the graph by a search term.

* **Filters:** Toggle visibility for `tags`, `attachments`, and `orphans`.

* **Color Groups:** Set custom colors for nodes using `path:` and `tag:` queries.

* **Display:** Customize the shape, size, and color for every element in the graph.

* **Forces:** Adjust the physics simulation to change the graph's layout and feel.

## Future Plans

* **Performance Optimizations:**

	* Implement a "Local Graph" mode for massive vaults.

* **UX Enhancements:**

	* Add more advanced query types for groups and search.

## Acknowledgements

This plugin relies heavily on the fantastic [3d-force-graph](https://github.com/vasturiano/3d-force-graph) library for rendering and physics.

Built with ❤️ for the Obsidian community.
