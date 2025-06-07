# 3D Graph for Obsidian
A plugin for Obsidian that provides a 3D, force-directed graph view of your vault. This offers an alternative, immersive way to visualize the connections between your notes.

## Features (V1)
- Interactive 3D Canvas: Pan, zoom, and rotate around your notes to explore their relationships from any angle.

- Node Interaction:

- Single-click on a node to focus the camera on it and highlight its immediate connections.

- Double-click on a node to open the corresponding file in a new tab.

- Orphan Hiding: Declutter your view with an option in the plugin settings to hide notes that have no links.

- Live Refresh: The graph updates instantly when you change settings—no need to close and reopen.

## How to Install
1. Download the main.js, manifest.json, and (if you add one) styles.css from the latest release.

2. In Obsidian, open Settings > Community plugins.

3. Make sure "Restricted mode" is turned off.

4. Open your vault's plugin folder by clicking the small folder icon next to "Installed plugins".

5. Create a new folder named 3d-graph-plugin.

6. Copy the downloaded files into this new folder.

7. Go back to Obsidian's "Community plugins" settings and click the refresh button.

8. Enable "3D Graph Plugin".

Once enabled, you can open the 3D Graph from the ribbon icon on the left sidebar.

## Settings
You can configure the 3D Graph by going to `Settings` > `3D Graph Plugin`.

- Show attachments: Toggles the visibility of non-markdown files in the graph.

- Hide orphans: Toggles the visibility of notes with no connections.

## Future Plans (V2)
- Enhanced customization for colors, node sizes, and forces.

- Visual distinction for different file types and tags.

- Performance optimizations for extremely large vaults.

- Local graph mode.

## Acknowledgements
This plugin relies heavily on the fantastic 3d-force-graph library for rendering and physics.

Built with ❤️ for the Obsidian community.
