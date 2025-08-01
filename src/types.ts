import * as THREE from 'three';

export interface ColorGroup {
	query: string;
	color: string;
}

export interface Filter {
	type: 'path' | 'tag';
	value: string;
	inverted: boolean;
}

export enum NodeShape { Sphere = 'Sphere', Cube = 'Cube', Pyramid = 'Pyramid', Tetrahedron = 'Tetrahedron' }

export interface Graph3DPluginSettings {
	// Search
	searchQuery: string;
	showNeighboringNodes: boolean;
	// Filters
	filters: Filter[];
	showAttachments: boolean;
	hideOrphans: boolean;
	showTags: boolean;
	// Groups
	groups: ColorGroup[];
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
	labelTextColorLight: string;
	labelTextColorDark: string;
	labelBackgroundColor: string;
	labelBackgroundOpacity: number;
	labelOcclusion: boolean;
	// Interaction
	useKeyboardControls: boolean;
	keyboardMoveSpeed: number; // Added for keyboard speed control
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
	filters: [],
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
	labelTextColorLight: '#000000',
	labelTextColorDark: '#ffffff',
	labelBackgroundColor: '#ffffff',
	labelBackgroundOpacity: 0.3,
	labelOcclusion: false,
	// Interaction
	useKeyboardControls: true,
	keyboardMoveSpeed: 2.0, // Added for keyboard speed control
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
	__threeObj?: THREE.Object3D;
	x?: number;
	y?: number;
	z?: number;
}

export interface GraphLink {
	source: string | GraphNode;
	target: string | GraphNode;
}
