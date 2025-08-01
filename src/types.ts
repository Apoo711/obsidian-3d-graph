import * as THREE from 'three';

// Renamed from GraphGroup for clarity
export interface ColorGroup {
	query: string;
	color: string;
}

// New type for the advanced filtering system
export interface Filter {
	type: 'path' | 'tag';
	value: string;
	inverted: boolean; // Added for NOT operator
}

export enum NodeShape { Sphere = 'Sphere', Cube = 'Cube', Pyramid = 'Pyramid', Tetrahedron = 'Tetrahedron' }

export interface Graph3DPluginSettings {
	// Search
	searchQuery: string;
	showNeighboringNodes: boolean;
	// Filters
	filters: Filter[]; // New advanced filters
	showAttachments: boolean;
	hideOrphans: boolean;
	showTags: boolean;
	// Groups
	groups: ColorGroup[]; // Renamed from GraphGroup
	// Display
	useThemeColors: boolean;
	colorNode: string;
	colorTag: string;
	colorAttachment: string;
	colorLink: string;
	colorHighlight: string;
	backgroundColor: string;
	// Appearance
	nodeSize: number;
	tagNodeSize: number;
	attachmentNodeSize: number;
	linkThickness: number;
	nodeShape: NodeShape;
	tagShape: NodeShape;
	attachmentShape: NodeShape;
	// Labels
	showNodeLabels: boolean;
	labelDistance: number;
	labelFadeThreshold: number;
	labelTextSize: number;
	labelTextColorLight: string; // New theme-aware color
	labelTextColorDark: string;  // New theme-aware color
	labelBackgroundColor: string; // New background color
	labelBackgroundOpacity: number; // New background opacity
	labelOcclusion: boolean;
	// Interaction
	zoomOnClick: boolean;
	rotateSpeed: number;
	panSpeed: number;
	zoomSpeed: number;
	// Forces
	centerForce: number;
	repelForce: number;
	linkForce: number;
}

export const DEFAULT_SETTINGS: Graph3DPluginSettings = {
	// Search
	searchQuery: '',
	showNeighboringNodes: true,
	// Filters
	filters: [], // New advanced filters
	showAttachments: false,
	hideOrphans: false,
	showTags: false,
	// Groups
	groups: [],
	// Display
	useThemeColors: true,
	colorNode: '#2080F0',
	colorTag: '#9A49E8',
	colorAttachment: '#75B63A',
	colorLink: '#666666',
	colorHighlight: '#FFB800',
	backgroundColor: '#0E0E10',
	// Appearance
	nodeSize: 1.5,
	tagNodeSize: 1.0,
	attachmentNodeSize: 1.2,
	linkThickness: 1,
	nodeShape: NodeShape.Sphere,
	tagShape: NodeShape.Tetrahedron,
	attachmentShape: NodeShape.Cube,
	// Labels
	showNodeLabels: true,
	labelDistance: 150,
	labelFadeThreshold: 0.8,
	labelTextSize: 2.5,
	labelTextColorLight: '#000000', // Default for light theme
	labelTextColorDark: '#ffffff',  // Default for dark theme
	labelBackgroundColor: '#ffffff',
	labelBackgroundOpacity: 0.3,
	labelOcclusion: false,
	// Interaction
	zoomOnClick: true,
	rotateSpeed: 1.0,
	panSpeed: 1.0,
	zoomSpeed: 1.0,
	// Forces
	centerForce: 0.1,
	repelForce: 10,
	linkForce: 0.01,
};

export enum NodeType { File, Tag, Attachment }

export interface GraphNode {
	id: string;
	name: string;
	filename?: string;
	type: NodeType;
	tags?: string[];
	content?: string;
	__threeObj?: THREE.Object3D; // Note: Changed to Object3D to support Groups
	x?: number;
	y?: number;
	z?: number;
}

export interface GraphLink {
	source: string | GraphNode;
	target: string | GraphNode;
}
