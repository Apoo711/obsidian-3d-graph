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

pub struct OctreeSoA {
    pub centers_of_mass: Vec<Vec3A>,
    pub masses: Vec<f32>,
    pub bounds_sizes: Vec<f32>,
    pub centers: Vec<Vec3A>,
    pub bounds_min: Vec<Vec3A>,
    pub bounds_max: Vec<Vec3A>,
    pub children: Vec<[u32; 8]>,
    pub node_indices: Vec<u32>,
    pub child_counts: Vec<u8>,
    insert_stack: Vec<(u32, u32, Vec3A)>,
    traversal_stack: Vec<u32>,
}

impl Default for OctreeSoA {
    fn default() -> Self {
        Self {
            centers_of_mass: Vec::new(),
            masses: Vec::new(),
            bounds_sizes: Vec::new(),
            centers: Vec::new(),
            bounds_min: Vec::new(),
            bounds_max: Vec::new(),
            children: Vec::new(),
            node_indices: Vec::new(),
            child_counts: Vec::new(),
            insert_stack: Vec::with_capacity(64),
            traversal_stack: Vec::with_capacity(64),
        }
    }
}

impl OctreeSoA {
    pub fn rebuild(&mut self, positions: &[Vec3A]) {
        self.clear();
        if positions.is_empty() {
            return;
        }

        let cap = positions.len() * 2;
        self.reserve(cap);

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

        self.push_leaf(root_min, root_max);

        for (idx, &pos) in positions.iter().enumerate() {
            self.insert_iter(idx as u32, pos, positions);
        }
    }

    fn clear(&mut self) {
        self.centers_of_mass.clear();
        self.masses.clear();
        self.bounds_sizes.clear();
        self.centers.clear();
        self.bounds_min.clear();
        self.bounds_max.clear();
        self.children.clear();
        self.node_indices.clear();
        self.child_counts.clear();
    }

    fn reserve(&mut self, cap: usize) {
        if self.masses.capacity() < cap {
            let additional = cap - self.masses.capacity();
            self.centers_of_mass.reserve(additional);
            self.masses.reserve(additional);
            self.bounds_sizes.reserve(additional);
            self.centers.reserve(additional);
            self.bounds_min.reserve(additional);
            self.bounds_max.reserve(additional);
            self.children.reserve(additional);
            self.node_indices.reserve(additional);
            self.child_counts.reserve(additional);
        }
    }

    fn push_leaf(&mut self, bounds_min: Vec3A, bounds_max: Vec3A) -> u32 {
        let idx = self.masses.len() as u32;
        let center = (bounds_min + bounds_max) * 0.5;
        let size = (bounds_max.x - bounds_min.x).abs();

        self.centers_of_mass.push(Vec3A::ZERO);
        self.masses.push(0.0);
        self.bounds_sizes.push(size);
        self.centers.push(center);
        self.bounds_min.push(bounds_min);
        self.bounds_max.push(bounds_max);
        self.children.push([EMPTY; 8]);
        self.node_indices.push(EMPTY);
        self.child_counts.push(0);

        idx
    }

    fn insert_iter(&mut self, item_idx: u32, pos: Vec3A, positions: &[Vec3A]) {
        self.insert_stack.clear();
        self.insert_stack.push((0u32, item_idx, pos));

        while let Some((node_idx, item_idx, pos)) = self.insert_stack.pop() {
            let idx = node_idx as usize;
            let m = self.masses[idx];
            let new_m = m + 1.0;
            self.centers_of_mass[idx] = (self.centers_of_mass[idx] * m + pos) / new_m;
            self.masses[idx] = new_m;

            let cur_node_index = self.node_indices[idx];
            let is_leaf = self.child_counts[idx] == 0;

            if cur_node_index == EMPTY && is_leaf {
                self.node_indices[idx] = item_idx;
                continue;
            }

            if cur_node_index != EMPTY {
                self.node_indices[idx] = EMPTY;
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
        let center = self.centers[node_idx as usize];
        let bx = (pos.x >= center.x) as usize;
        let by = (pos.y >= center.y) as usize;
        let bz = (pos.z >= center.z) as usize;
        bx | (by << 1) | (bz << 2)
    }

    #[inline]
    fn get_or_create_child(&mut self, parent_idx: u32, octant: usize) -> u32 {
        let p_idx = parent_idx as usize;
        let existing = self.children[p_idx][octant];
        if existing != EMPTY {
            return existing;
        }

        let p_min = self.bounds_min[p_idx];
        let p_max = self.bounds_max[p_idx];
        let center = self.centers[p_idx];

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

        let new_idx = self.push_leaf(c_min, c_max);
        self.children[p_idx][octant] = new_idx;
        self.child_counts[p_idx] += 1;
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
        if self.masses.is_empty() {
            return force_acc;
        }

        self.traversal_stack.clear();
        self.traversal_stack.push(0u32);

        while let Some(node_idx) = self.traversal_stack.pop() {
            let idx = node_idx as usize;
            let m = self.masses[idx];
            if m == 0.0 {
                continue;
            }

            let delta = pos - self.centers_of_mass[idx];
            let dist_sq = delta.length_squared().max(1.0);
            let dist = dist_sq.sqrt();
            let bounds_size = self.bounds_sizes[idx];

            if self.child_counts[idx] == 0 || (bounds_size / dist) < theta {
                let n_idx = self.node_indices[idx];
                if n_idx != self_item_idx {
                    let f_mag = (repulsion_const * m) / (dist_sq * dist);
                    force_acc += delta * f_mag;
                }
            } else {
                for &child_idx in &self.children[idx] {
                    if child_idx != EMPTY {
                        self.traversal_stack.push(child_idx);
                    }
                }
            }
        }

        force_acc
    }
}

pub struct SpatialHashGrid3D {
    pub cell_size: f32,
    pub inv_cell_size: f32,
    table_size: usize,
    cell_heads: Vec<u32>,
    next_node: Vec<u32>,
}

impl SpatialHashGrid3D {
    pub fn new(capacity: usize) -> Self {
        let table_size = (capacity * 2).next_power_of_two().max(256);
        Self {
            cell_size: 50.0,
            inv_cell_size: 1.0 / 50.0,
            table_size,
            cell_heads: vec![EMPTY; table_size],
            next_node: vec![EMPTY; capacity],
        }
    }

    #[inline(always)]
    fn hash_coords(&self, cx: i32, cy: i32, cz: i32) -> usize {
        let h =
            (cx.wrapping_mul(73856093)) ^ (cy.wrapping_mul(19349663)) ^ (cz.wrapping_mul(83492791));
        (h as usize) & (self.table_size - 1)
    }

    pub fn rebuild(&mut self, positions: &[Vec3A], cell_size: f32) {
        let n = positions.len();
        self.cell_size = cell_size.max(1.0);
        self.inv_cell_size = 1.0 / self.cell_size;

        if self.next_node.len() < n {
            self.next_node.resize(n, EMPTY);
        }

        let needed_table = (n * 2).next_power_of_two().max(256);
        if self.table_size != needed_table {
            self.table_size = needed_table;
            self.cell_heads.resize(needed_table, EMPTY);
        }

        self.cell_heads.fill(EMPTY);

        for (i, &p) in positions.iter().enumerate() {
            let cx = (p.x * self.inv_cell_size).floor() as i32;
            let cy = (p.y * self.inv_cell_size).floor() as i32;
            let cz = (p.z * self.inv_cell_size).floor() as i32;
            let bucket = self.hash_coords(cx, cy, cz);

            self.next_node[i] = self.cell_heads[bucket];
            self.cell_heads[bucket] = i as u32;
        }
    }

    pub fn query_radius(&self, positions: &[Vec3A], center: Vec3A, radius: f32) -> Vec<u32> {
        let mut results = Vec::new();
        if positions.is_empty() {
            return results;
        }

        let r_sq = radius * radius;
        let min_c = (center - Vec3A::splat(radius)) * self.inv_cell_size;
        let max_c = (center + Vec3A::splat(radius)) * self.inv_cell_size;

        let min_x = min_c.x.floor() as i32;
        let max_x = max_c.x.floor() as i32;
        let min_y = min_c.y.floor() as i32;
        let max_y = max_c.y.floor() as i32;
        let min_z = min_c.z.floor() as i32;
        let max_z = max_c.z.floor() as i32;

        for x in min_x..=max_x {
            for y in min_y..=max_y {
                for z in min_z..=max_z {
                    let bucket = self.hash_coords(x, y, z);
                    let mut curr = self.cell_heads[bucket];
                    while curr != EMPTY {
                        let idx = curr as usize;
                        if idx < positions.len() {
                            let d_sq = (positions[idx] - center).length_squared();
                            if d_sq <= r_sq {
                                results.push(curr);
                            }
                        }
                        curr = self.next_node[idx];
                    }
                }
            }
        }

        results
    }

    pub fn find_nearest(&self, positions: &[Vec3A], point: Vec3A, max_dist: f32) -> Option<u32> {
        if positions.is_empty() {
            return None;
        }

        let mut closest_dist_sq = max_dist * max_dist;
        let mut closest_idx = None;

        let min_c = (point - Vec3A::splat(max_dist)) * self.inv_cell_size;
        let max_c = (point + Vec3A::splat(max_dist)) * self.inv_cell_size;

        let min_x = min_c.x.floor() as i32;
        let max_x = max_c.x.floor() as i32;
        let min_y = min_c.y.floor() as i32;
        let max_y = max_c.y.floor() as i32;
        let min_z = min_c.z.floor() as i32;
        let max_z = max_c.z.floor() as i32;

        for x in min_x..=max_x {
            for y in min_y..=max_y {
                for z in min_z..=max_z {
                    let bucket = self.hash_coords(x, y, z);
                    let mut curr = self.cell_heads[bucket];
                    while curr != EMPTY {
                        let idx = curr as usize;
                        if idx < positions.len() {
                            let d_sq = (positions[idx] - point).length_squared();
                            if d_sq < closest_dist_sq {
                                closest_dist_sq = d_sq;
                                closest_idx = Some(curr);
                            }
                        }
                        curr = self.next_node[idx];
                    }
                }
            }
        }

        closest_idx
    }
}

/// The stride in `f32` units per 3D position vector in memory.
///
/// We use `glam::Vec3A` which is 16-byte aligned (4 x 32-bit floats: `[x, y, z,
/// pad]`). This matches WASM `v128` SIMD register layout and enables direct
/// zero-copy buffer views into JS Float32Array.
pub const POSITION_STRIDE: usize = 4;

pub struct PhysicsEngine {
    pub positions: Vec<Vec3A>,
    pub velocities: Vec<Vec3A>,
    pub forces: Vec<Vec3A>,
    pub edges: Vec<u32>,
    pub params: SimulationParams,
    pub kinetic_energy: f32,
    octree: OctreeSoA,
    pub spatial_hash: SpatialHashGrid3D,
    positions_len: usize,
}

impl PhysicsEngine {
    pub fn new(node_count: usize, edges: Vec<u32>, params: SimulationParams) -> Self {
        debug_assert_eq!(std::mem::size_of::<Vec3A>(), 16);
        let positions_len = node_count * POSITION_STRIDE;
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

        let spatial_hash = SpatialHashGrid3D::new(node_count);

        Self {
            positions,
            velocities,
            forces,
            edges,
            params,
            kinetic_energy: 1.0,
            octree: OctreeSoA::default(),
            spatial_hash,
            positions_len,
        }
    }

    pub fn set_positions_flat(&mut self, flat_in: &[f32]) {
        let n = self.positions.len();
        if flat_in.len() >= n * 4 {
            for i in 0..n {
                self.positions[i] =
                    Vec3A::new(flat_in[i * 4], flat_in[i * 4 + 1], flat_in[i * 4 + 2]);
            }
        } else {
            let count = n.min(flat_in.len() / 3);
            for i in 0..count {
                self.positions[i] =
                    Vec3A::new(flat_in[i * 3], flat_in[i * 3 + 1], flat_in[i * 3 + 2]);
            }
        }
        self.kinetic_energy = 1.0;
    }

    #[inline(always)]
    pub fn positions_ptr(&self) -> *const f32 {
        self.positions.as_ptr() as *const f32
    }

    #[inline(always)]
    pub fn positions_len(&self) -> usize {
        self.positions_len
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

    pub fn rebuild_spatial_hash(&mut self, cell_size: f32) {
        self.spatial_hash.rebuild(&self.positions, cell_size);
    }

    pub fn query_radius(&self, center: Vec3A, radius: f32) -> Vec<u32> {
        self.spatial_hash
            .query_radius(&self.positions, center, radius)
    }

    pub fn find_nearest(&self, point: Vec3A, max_dist: f32) -> Option<u32> {
        self.spatial_hash
            .find_nearest(&self.positions, point, max_dist)
    }
}
