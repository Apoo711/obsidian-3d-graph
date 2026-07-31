use glam::Vec3A;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
    pub child_indices: [Option<usize>; 8],
    pub node_index: Option<usize>,
}

#[derive(Default)]
pub struct Octree {
    pub nodes: Vec<OctreeNode>,
}

impl Octree {
    pub fn rebuild(&mut self, positions: &[Vec3A]) {
        self.nodes.clear();
        if positions.is_empty() {
            return;
        }

        if self.nodes.capacity() < positions.len() * 2 {
            self.nodes.reserve(positions.len() * 2 - self.nodes.capacity());
        }

        let mut min = positions[0];
        let mut max = positions[0];
        for &p in positions.iter().skip(1) {
            min = min.min(p);
            max = max.max(p);
        }

        let center = (min + max) * 0.5;
        let extent = ((max - min) * 0.5).max(Vec3A::splat(1.0));
        let half_size = extent.max_element();

        min = center - Vec3A::splat(half_size);
        max = center + Vec3A::splat(half_size);

        let root = OctreeNode {
            center_of_mass: Vec3A::ZERO,
            mass: 0.0,
            bounds_min: min,
            bounds_max: max,
            child_indices: [None; 8],
            node_index: None,
        };
        self.nodes.push(root);

        for (idx, &pos) in positions.iter().enumerate() {
            self.insert(0, idx, pos);
        }
    }

    fn insert(&mut self, node_idx: usize, item_idx: usize, pos: Vec3A) {
        let new_mass = self.nodes[node_idx].mass + 1.0;
        self.nodes[node_idx].center_of_mass =
            (self.nodes[node_idx].center_of_mass * self.nodes[node_idx].mass + pos) / new_mass;
        self.nodes[node_idx].mass = new_mass;

        if self.nodes[node_idx].node_index.is_none()
            && self.nodes[node_idx].child_indices.iter().all(|c| c.is_none())
        {
            self.nodes[node_idx].node_index = Some(item_idx);
            return;
        }

        if let Some(existing_idx) = self.nodes[node_idx].node_index.take() {
            let existing_pos = self.nodes[node_idx].center_of_mass;
            let octant = self.get_octant(node_idx, existing_pos);
            let child_idx = self.get_or_create_child(node_idx, octant);
            self.insert(child_idx, existing_idx, existing_pos);
        }

        let octant = self.get_octant(node_idx, pos);
        let child_idx = self.get_or_create_child(node_idx, octant);
        self.insert(child_idx, item_idx, pos);
    }

    fn get_octant(&self, node_idx: usize, pos: Vec3A) -> usize {
        let center = (self.nodes[node_idx].bounds_min + self.nodes[node_idx].bounds_max) * 0.5;
        let mut octant = 0;
        if pos.x >= center.x {
            octant |= 1;
        }
        if pos.y >= center.y {
            octant |= 2;
        }
        if pos.z >= center.z {
            octant |= 4;
        }
        octant
    }

    fn get_or_create_child(&mut self, parent_idx: usize, octant: usize) -> usize {
        if let Some(child) = self.nodes[parent_idx].child_indices[octant] {
            return child;
        }

        let p_min = self.nodes[parent_idx].bounds_min;
        let p_max = self.nodes[parent_idx].bounds_max;
        let center = (p_min + p_max) * 0.5;

        let mut c_min = p_min;
        let mut c_max = center;

        if (octant & 1) != 0 {
            c_min.x = center.x;
            c_max.x = p_max.x;
        }
        if (octant & 2) != 0 {
            c_min.y = center.y;
            c_max.y = p_max.y;
        }
        if (octant & 4) != 0 {
            c_min.z = center.z;
            c_max.z = p_max.z;
        }

        let new_child_idx = self.nodes.len();
        self.nodes.push(OctreeNode {
            center_of_mass: Vec3A::ZERO,
            mass: 0.0,
            bounds_min: c_min,
            bounds_max: c_max,
            child_indices: [None; 8],
            node_index: None,
        });

        self.nodes[parent_idx].child_indices[octant] = Some(new_child_idx);
        new_child_idx
    }

    pub fn compute_repulsion(
        &self,
        node_idx: usize,
        pos: Vec3A,
        self_item_idx: usize,
        repulsion_const: f32,
        theta: f32,
        force_acc: &mut Vec3A,
    ) {
        let node = &self.nodes[node_idx];
        if node.mass == 0.0 {
            return;
        }

        let delta = pos - node.center_of_mass;
        let dist_sq = delta.length_squared().max(1.0);
        let dist = dist_sq.sqrt();

        let size = (node.bounds_max.x - node.bounds_min.x).abs();

        if node.child_indices.iter().all(|c| c.is_none()) || (size / dist) < theta {
            if node.node_index != Some(self_item_idx) {
                let f_mag = (repulsion_const * node.mass) / (dist_sq * dist);
                *force_acc += delta * f_mag;
            }
        } else {
            for child_opt in node.child_indices.iter() {
                if let Some(child_idx) = child_opt {
                    self.compute_repulsion(
                        *child_idx,
                        pos,
                        self_item_idx,
                        repulsion_const,
                        theta,
                        force_acc,
                    );
                }
            }
        }
    }
}

pub struct PhysicsEngine {
    pub positions: Vec<Vec3A>,
    pub velocities: Vec<Vec3A>,
    pub forces: Vec<Vec3A>,
    pub edges: Vec<u32>,
    pub params: SimulationParams,
    pub flat_positions: Vec<f32>,
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
            let phi = ((1.0 - 2.0 * (i as f32 + 0.5) / (node_count as f32)).clamp(-1.0, 1.0)).acos();
            let r = radius_scale * ((i as f32 + 1.0) / (node_count as f32)).sqrt();

            let x = r * phi.sin() * theta.cos();
            let y = r * phi.sin() * theta.sin();
            let z = r * phi.cos();

            positions.push(Vec3A::new(x, y, z));
        }

        let mut flat_positions = vec![0.0; node_count * 3];
        Self::sync_flat_buffer(&positions, &mut flat_positions);

        Self {
            positions,
            velocities,
            forces,
            edges,
            params,
            flat_positions,
            kinetic_energy: 1.0,
            octree: Octree::default(),
        }
    }

    fn sync_flat_buffer(positions: &[Vec3A], flat: &mut [f32]) {
        for (i, p) in positions.iter().enumerate() {
            flat[i * 3] = p.x;
            flat[i * 3 + 1] = p.y;
            flat[i * 3 + 2] = p.z;
        }
    }

    pub fn set_positions_flat(&mut self, flat_in: &[f32]) {
        let count = self.positions.len().min(flat_in.len() / 3);
        for i in 0..count {
            self.positions[i] = Vec3A::new(flat_in[i * 3], flat_in[i * 3 + 1], flat_in[i * 3 + 2]);
        }
        self.kinetic_energy = 1.0;
        Self::sync_flat_buffer(&self.positions, &mut self.flat_positions);
    }

    pub fn step(&mut self) -> bool {
        let n = self.positions.len();
        if n == 0 {
            return false;
        }

        if self.kinetic_energy < self.params.alpha_min {
            return false;
        }

        for f in self.forces.iter_mut() {
            *f = Vec3A::ZERO;
        }

        if n > 500 {
            self.octree.rebuild(&self.positions);
            for i in 0..n {
                let mut rep_force = Vec3A::ZERO;
                self.octree.compute_repulsion(
                    0,
                    self.positions[i],
                    i,
                    self.params.repulsion,
                    self.params.theta,
                    &mut rep_force,
                );
                self.forces[i] += rep_force;
            }
        } else {
            let rep_const = self.params.repulsion;
            for i in 0..n {
                let pos_i = self.positions[i];
                let mut f_acc = Vec3A::ZERO;
                for j in (i + 1)..n {
                    let delta = pos_i - self.positions[j];
                    let dist_sq = delta.length_squared().max(1.0);
                    let f_mag = rep_const / (dist_sq * dist_sq.sqrt());
                    let force = delta * f_mag;

                    f_acc += force;
                    self.forces[j] -= force;
                }
                self.forces[i] += f_acc;
            }
        }

        let edge_count = self.edges.len() / 2;
        let k = self.params.attraction;
        let rest_len = self.params.link_distance;

        for e in 0..edge_count {
            let src = self.edges[e * 2] as usize;
            let tgt = self.edges[e * 2 + 1] as usize;

            if src < n && tgt < n && src != tgt {
                let delta = self.positions[tgt] - self.positions[src];
                let dist = delta.length().max(0.1);
                let stretch = dist - rest_len;
                let force = (delta / dist) * (k * stretch);

                self.forces[src] += force;
                self.forces[tgt] -= force;
            }
        }

        let g = self.params.gravity;
        for i in 0..n {
            self.forces[i] -= self.positions[i] * g;
        }

        let dt = self.params.dt;
        let damping = self.params.damping;
        let max_v = self.params.max_velocity;

        let mut total_v_sq = 0.0;
        for i in 0..n {
            let v = (self.velocities[i] + self.forces[i] * dt) * damping;
            let v_sq = v.length_squared();
            total_v_sq += v_sq;

            let v_len = v_sq.sqrt();
            let v_clamped = if v_len > max_v {
                (v / v_len) * max_v
            } else {
                v
            };

            self.velocities[i] = v_clamped;
            self.positions[i] += v_clamped * dt;
        }

        self.kinetic_energy = total_v_sq / (n as f32);
        Self::sync_flat_buffer(&self.positions, &mut self.flat_positions);
        true
    }
}
