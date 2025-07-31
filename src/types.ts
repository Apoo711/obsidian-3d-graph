import * as THREE from 'three';

export interface GraphGroup {
	query: string;
	color: string;
}

export enum NodeShape { Sphere = 'Sphere', Cube = 'Cube', Pyramid = 'Pyramid', Tetrahedron = 'Tetrahedron' }

export interface Graph3DPluginSettings {
	// Search
	searchQuery: string;
	showNeighboringNodes: boolean;
	// Filters
	showAttachments: boolean;
	hideOrphans: boolean;
	showTags: boolean;
	// Groups
	groups: GraphGroup[];
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
	labelTextColor: string;
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
	labelTextColor: '#ffffff',
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
	__threeObj?: THREE.Mesh;
	x?: number;
	y?: number;
	z?: number;
}

export interface GraphLink {
	source: string | GraphNode;
	target: string | GraphNode;
}
