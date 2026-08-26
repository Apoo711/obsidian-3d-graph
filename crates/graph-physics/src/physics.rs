use glam::Vec3A;
use serde::{Deserialize, Serialize};

const EMPTY: u32 = u32::MAX;

const OCTREE_THRESHOLD: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct SimulationParams {
    pub repulsion: f32,
    pub attraction: f32,
    pub link_distance: f32,
    pub gravity: f32,
    pub damping: f32,
    pub max_velocity: f32,
    pub dt: f32,
    pub theta: f32,
    pub alpha_min: f32,
}

impl Default for SimulationParams {
    fn default() -> Self {
        Self {
            repulsion: 400.0,
            attraction: 0.02,
            link_distance: 30.0,
            gravity: 0.05,
            damping: 0.85,
            max_velocity: 40.0,
            dt: 0.3,
            theta: 0.8,
            alpha_min: 0.001,
        }
    }
}

pub struct OctreeNode {
    pub center_of_mass: Vec3A,
    pub mass: f32,
    pub bounds_min: Vec3A,
    pub bounds_max: Vec3A,
    pub center: Vec3A,
    pub children: [u32; 8],
    pub node_index: u32,
    pub child_count: u8,
}

impl OctreeNode {
    #[inline]
    fn new_leaf(bounds_min: Vec3A, bounds_max: Vec3A) -> Self {
        Self {
            center_of_mass: Vec3A::ZERO,
            mass: 0.0,
            bounds_min,
            bounds_max,
            center: (bounds_min + bounds_max) * 0.5,
            children: [EMPTY; 8],
            node_index: EMPTY,
            child_count: 0,
        }
    }

    #[inline(always)]
    fn is_leaf(&self) -> bool {
        self.child_count == 0
    }
}

pub struct Octree {
    pub nodes: Vec<OctreeNode>,
    insert_stack: Vec<(u32, u32, Vec3A)>,
    traversal_stack: Vec<u32>,
}

impl Default for Octree {
    fn default() -> Self {
        Self {
            nodes: Vec::new(),
            insert_stack: Vec::with_capacity(64),
            traversal_stack: Vec::with_capacity(64),
        }
    }
}

impl Octree {
    pub fn rebuild(&mut self, positions: &[Vec3A]) {
        self.nodes.clear();
        if positions.is_empty() {
            return;
        }

        let cap = positions.len() * 2;
        if self.nodes.capacity() < cap {
            self.nodes.reserve(cap - self.nodes.capacity());
        }

        let mut bmin = positions[0];
        let mut bmax = positions[0];
        for &p in positions.iter().skip(1) {
            bmin = bmin.min(p);
            bmax = bmax.max(p);
        }

        let center = (bmin + bmax) * 0.5;
        let half = ((bmax - bmin) * 0.5).max(Vec3A::splat(1.0)).max_element();
        let root_min = center - Vec3A::splat(half);
        let root_max = center + Vec3A::splat(half);

        self.nodes.push(OctreeNode::new_leaf(root_min, root_max));

        for (idx, &pos) in positions.iter().enumerate() {
            self.insert_iter(idx as u32, pos, positions);
        }
    }

    fn insert_iter(&mut self, item_idx: u32, pos: Vec3A, positions: &[Vec3A]) {
        self.insert_stack.clear();
        self.insert_stack.push((0u32, item_idx, pos));

        while let Some((node_idx, item_idx, pos)) = self.insert_stack.pop() {
            {
                let node = &mut self.nodes[node_idx as usize];
                let new_mass = node.mass + 1.0;
                node.center_of_mass = (node.center_of_mass * node.mass + pos) / new_mass;
                node.mass = new_mass;
            }

            let (cur_node_index, is_leaf) = {
                let node = &self.nodes[node_idx as usize];
                (node.node_index, node.is_leaf())
            };

            if cur_node_index == EMPTY && is_leaf {
                self.nodes[node_idx as usize].node_index = item_idx;
                continue;
            }

            if cur_node_index != EMPTY {
                self.nodes[node_idx as usize].node_index = EMPTY;
                let existing_pos = positions[cur_node_index as usize];
                let oct = self.get_octant(node_idx, existing_pos);
                let child = self.get_or_create_child(node_idx, oct);
                self.insert_stack
                    .push((child, cur_node_index, existing_pos));
            }

            let oct = self.get_octant(node_idx, pos);
            let child = self.get_or_create_child(node_idx, oct);
            self.insert_stack.push((child, item_idx, pos));
        }
    }

    #[inline(always)]
    fn get_octant(&self, node_idx: u32, pos: Vec3A) -> usize {
        let n = &self.nodes[node_idx as usize];
        let center = n.center;
        let bx = (pos.x >= center.x) as usize;
        let by = (pos.y >= center.y) as usize;
        let bz = (pos.z >= center.z) as usize;
        bx | (by << 1) | (bz << 2)
    }

    #[inline]
    fn get_or_create_child(&mut self, parent_idx: u32, octant: usize) -> u32 {
        if self.nodes[parent_idx as usize].children[octant] != EMPTY {
            return self.nodes[parent_idx as usize].children[octant];
        }

        let (p_min, p_max, center) = {
            let p = &self.nodes[parent_idx as usize];
            (p.bounds_min, p.bounds_max, p.center)
        };

        let c_min = Vec3A::new(
            if (octant & 1) != 0 { center.x } else { p_min.x },
            if (octant & 2) != 0 { center.y } else { p_min.y },
            if (octant & 4) != 0 { center.z } else { p_min.z },
        );
        let c_max = Vec3A::new(
            if (octant & 1) != 0 { p_max.x } else { center.x },
            if (octant & 2) != 0 { p_max.y } else { center.y },
            if (octant & 4) != 0 { p_max.z } else { center.z },
        );

        let new_idx = self.nodes.len() as u32;
        self.nodes.push(OctreeNode::new_leaf(c_min, c_max));
        self.nodes[parent_idx as usize].children[octant] = new_idx;
        self.nodes[parent_idx as usize].child_count += 1;
        new_idx
    }

    pub fn compute_repulsion_iter(
        &mut self,
        pos: Vec3A,
        self_item_idx: u32,
        repulsion_const: f32,
        theta: f32,
    ) -> Vec3A {
        let mut force_acc = Vec3A::ZERO;
        if self.nodes.is_empty() {
            return force_acc;
        }

        self.traversal_stack.clear();
        self.traversal_stack.push(0u32);

        while let Some(node_idx) = self.traversal_stack.pop() {
            let n = &self.nodes[node_idx as usize];

            if n.mass == 0.0 {
                continue;
            }

            let delta = pos - n.center_of_mass;
            let dist_sq = delta.length_squared().max(1.0);
            let dist = dist_sq.sqrt();
            let bounds_size = (n.bounds_max.x - n.bounds_min.x).abs();

            if n.child_count == 0 || (bounds_size / dist) < theta {
                if n.node_index != self_item_idx {
                    let f_mag = (repulsion_const * n.mass) / (dist_sq * dist);
                    force_acc += delta * f_mag;
                }
            } else {
                for &child_idx in &n.children {
                    if child_idx != EMPTY {
                        self.traversal_stack.push(child_idx);
                    }
                }
            }
        }

        force_acc
    }
}

pub struct PhysicsEngine {
    pub positions: Vec<Vec3A>,
    pub velocities: Vec<Vec3A>,
    pub forces: Vec<Vec3A>,
    pub edges: Vec<u32>,
    pub params: SimulationParams,
    pub kinetic_energy: f32,
    octree: Octree,
}

impl PhysicsEngine {
    pub fn new(node_count: usize, edges: Vec<u32>, params: SimulationParams) -> Self {
        let mut positions = Vec::with_capacity(node_count);
        let velocities = vec![Vec3A::ZERO; node_count];
        let forces = vec![Vec3A::ZERO; node_count];

        let golden_ratio = (1.0 + 5.0_f32.sqrt()) / 2.0;
        let radius_scale = 50.0 * (node_count as f32).sqrt().max(1.0);

        for i in 0..node_count {
            let theta = 2.0 * std::f32::consts::PI * (i as f32) / golden_ratio;
            let phi = if node_count <= 1 {
                0.0
            } else {
                ((1.0 - 2.0 * (i as f32 + 0.5) / node_count as f32).clamp(-1.0, 1.0)).acos()
            };
            let r = radius_scale * ((i as f32 + 1.0) / node_count as f32).sqrt();
            positions.push(Vec3A::new(
                r * phi.sin() * theta.cos(),
                r * phi.sin() * theta.sin(),
                r * phi.cos(),
            ));
        }

        Self {
            positions,
            velocities,
            forces,
            edges,
            params,
            kinetic_energy: 1.0,
            octree: Octree::default(),
        }
    }

    pub fn set_positions_flat(&mut self, flat_in: &[f32]) {
        let n = self.positions.len();
        if flat_in.len() >= n * 4 {
            for i in 0..n {
                self.positions[i] = Vec3A::new(flat_in[i * 4], flat_in[i * 4 + 1], flat_in[i * 4 + 2]);
            }
        } else {
            let count = n.min(flat_in.len() / 3);
            for i in 0..count {
                self.positions[i] = Vec3A::new(flat_in[i * 3], flat_in[i * 3 + 1], flat_in[i * 3 + 2]);
            }
        }
        self.kinetic_energy = 1.0;
    }

    #[inline]
    pub fn positions_ptr(&self) -> *const f32 {
        self.positions.as_ptr() as *const f32
    }

    #[inline]
    pub fn positions_len(&self) -> usize {
        self.positions.len() * 4
    }

    pub fn step(&mut self) -> bool {
        let n = self.positions.len();
        if n == 0 || self.kinetic_energy < self.params.alpha_min {
            return false;
        }

        for f in self.forces.iter_mut() {
            *f = Vec3A::ZERO;
        }

        if n > OCTREE_THRESHOLD {
            self.octree.rebuild(&self.positions);
            for i in 0..n {
                let pos_i = self.positions[i];
                let rep = self.octree.compute_repulsion_iter(
                    pos_i,
                    i as u32,
                    self.params.repulsion,
                    self.params.theta,
                );
                self.forces[i] += rep;
            }
        } else {
            let rep_const = self.params.repulsion;
            for i in 0..n {
                let pi = self.positions[i];
                let mut fi = Vec3A::ZERO;
                for j in (i + 1)..n {
                    let delta = pi - self.positions[j];
                    let dist_sq = delta.length_squared().max(1.0);
                    let f = delta * (rep_const / (dist_sq * dist_sq.sqrt()));
                    fi += f;
                    self.forces[j] -= f;
                }
                self.forces[i] += fi;
            }
        }

        {
            let k = self.params.attraction;
            let rest = self.params.link_distance;
            let edge_count = self.edges.len() / 2;
            for e in 0..edge_count {
                let src = self.edges[e * 2] as usize;
                let tgt = self.edges[e * 2 + 1] as usize;
                if src < n && tgt < n && src != tgt {
                    let delta = self.positions[tgt] - self.positions[src];
                    let dist = delta.length().max(0.1);
                    let force = delta * (k * (dist - rest) / dist);
                    self.forces[src] += force;
                    self.forces[tgt] -= force;
                }
            }
        }

        {
            let g = self.params.gravity;
            for i in 0..n {
                self.forces[i] -= self.positions[i] * g;
            }
        }

        {
            let dt = self.params.dt;
            let damping = self.params.damping;
            let max_v = self.params.max_velocity;
            let max_v_sq = max_v * max_v;
            let mut total_v_sq = 0.0_f32;

            for i in 0..n {
                let v = (self.velocities[i] + self.forces[i] * dt) * damping;
                let v_sq = v.length_squared();
                total_v_sq += v_sq;
                self.velocities[i] = if v_sq > max_v_sq {
                    v * (max_v / v_sq.sqrt())
                } else {
                    v
                };
                self.positions[i] += self.velocities[i] * dt;
            }

            self.kinetic_energy = total_v_sq / (n as f32);
        }

        true
    }

    pub fn shortest_path_hops(&self, start: u32) -> Vec<i32> {
        let n = self.positions.len();
        let mut dists = vec![-1i32; n];
        if (start as usize) >= n {
            return dists;
        }

        let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
        let edge_count = self.edges.len() >> 1;
        for e in 0..edge_count {
            let u = self.edges[e * 2];
            let v = self.edges[e * 2 + 1];
            if (u as usize) < n && (v as usize) < n && u != v {
                adj[u as usize].push(v);
                adj[v as usize].push(u);
            }
        }

        let mut queue = std::collections::VecDeque::new();
        dists[start as usize] = 0;
        queue.push_back(start);

        while let Some(u) = queue.pop_front() {
            let d = dists[u as usize];
            for &v in &adj[u as usize] {
                if dists[v as usize] == -1 {
                    dists[v as usize] = d + 1;
                    queue.push_back(v);
                }
            }
        }

        dists
    }

    pub fn connected_components(&self) -> Vec<u32> {
        let n = self.positions.len();
        let mut comp = vec![u32::MAX; n];
        if n == 0 {
            return comp;
        }

        let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
        let edge_count = self.edges.len() >> 1;
        for e in 0..edge_count {
            let u = self.edges[e * 2];
            let v = self.edges[e * 2 + 1];
            if (u as usize) < n && (v as usize) < n && u != v {
                adj[u as usize].push(v);
                adj[v as usize].push(u);
            }
        }

        let mut current_comp = 0u32;
        let mut queue = std::collections::VecDeque::new();

        for i in 0..n {
            if comp[i] != u32::MAX {
                continue;
            }
            comp[i] = current_comp;
            queue.push_back(i as u32);

            while let Some(u) = queue.pop_front() {
                for &v in &adj[u as usize] {
                    if comp[v as usize] == u32::MAX {
                        comp[v as usize] = current_comp;
                        queue.push_back(v);
                    }
                }
            }
            current_comp += 1;
        }

        comp
    }

    pub fn node_degrees(&self) -> Vec<u32> {
        let n = self.positions.len();
        let mut degs = vec![0u32; n];
        let edge_count = self.edges.len() >> 1;
        for e in 0..edge_count {
            let u = self.edges[e * 2] as usize;
            let v = self.edges[e * 2 + 1] as usize;
            if u < n && v < n && u != v {
                degs[u] += 1;
                degs[v] += 1;
            }
        }
        degs
    }
}
