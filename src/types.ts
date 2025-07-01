import * as THREE from 'three';

export interface GraphGroup {
	query: string;
	color: string;
}

export enum NodeShape { Sphere = 'Sphere', Cube = 'Cube', Pyramid = 'Pyramid', Tetrahedron = 'Tetrahedron' }

export interface Graph3DPluginSettings {
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

export const DEFAULT_SETTINGS: Graph3DPluginSettings = {
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
