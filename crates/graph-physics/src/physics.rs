use glam::Vec3A;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Sentinel value meaning "no child" / "no item stored here".
const EMPTY: u32 = u32::MAX;

/// Switch from O(N²) brute-force to Barnes-Hut octree above this node count.
/// Lowered from 500: at 64 nodes the octree overhead is negligible, and graphs
/// between 64-500 nodes previously ran at O(N²) — the worst possible scaling.
const OCTREE_THRESHOLD: usize = 64;

// ---------------------------------------------------------------------------
// SimulationParams
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// OctreeNode — compact layout using u32 sentinels
// ---------------------------------------------------------------------------
//
// WHY: The original used [Option<usize>; 8] + Option<usize> for child_indices
// and node_index. On 64-bit, Option<usize> is 16 bytes (no niche), so:
//   Old: [Option<usize>;8] = 128 bytes + Option<usize> = 16 bytes → ~196 B/node
//   New: [u32;8]           =  32 bytes + u32            =  4 bytes → ~88  B/node
// 2.2× reduction in node size → ~2.2× more octree nodes fit in L2 cache.

pub struct OctreeNode {
    pub center_of_mass: Vec3A, // 16 bytes (SIMD-aligned)
    pub mass: f32,             //  4 bytes
    pub bounds_min: Vec3A,     // 16 bytes
    pub bounds_max: Vec3A,     // 16 bytes
    /// Child octant indices into `Octree::nodes`.  EMPTY (u32::MAX) = no child.
    pub children: [u32; 8], //  32 bytes
    /// Index of the graph node stored at this leaf.  EMPTY = none.
    pub node_index: u32, //  4 bytes
}

impl OctreeNode {
    #[inline]
    fn new_leaf(bounds_min: Vec3A, bounds_max: Vec3A) -> Self {
        Self {
            center_of_mass: Vec3A::ZERO,
            mass: 0.0,
            bounds_min,
            bounds_max,
            children: [EMPTY; 8],
            node_index: EMPTY,
        }
    }

    #[inline(always)]
    fn is_leaf(&self) -> bool {
        // All 8 children are EMPTY.
        self.children.iter().all(|&c| c == EMPTY)
    }
}

// ---------------------------------------------------------------------------
// Octree
// ---------------------------------------------------------------------------
//
// WHY iterative instead of recursive:
//   Recursive insert/traverse accumulates O(log₈ N) stack frames per call.
//   For 10 k nodes that is ~14 nested Rust frames per insertion, repeated 10 k
//   times = 140 k stack ops.  The iterative version reuses a pre-allocated Vec
//   as an explicit stack — zero heap allocation in steady state.

pub struct Octree {
    pub nodes: Vec<OctreeNode>,
    /// Reusable work-stack for iterative insertion.  Cleared on each rebuild.
    insert_stack: Vec<(u32, u32, Vec3A)>,
    /// Reusable work-stack for iterative Barnes-Hut traversal.
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

        // Pre-reserve capacity to avoid Vec reallocations during insertion.
        // Worst case: fully unbalanced tree ≈ 2×N nodes.
        let cap = positions.len() * 2;
        if self.nodes.capacity() < cap {
            self.nodes.reserve(cap - self.nodes.capacity());
        }

        // Compute tight AABB.
        let mut bmin = positions[0];
        let mut bmax = positions[0];
        for &p in positions.iter().skip(1) {
            bmin = bmin.min(p);
            bmax = bmax.max(p);
        }

        // Expand to a cube so all octants are equal-sided.
        let center = (bmin + bmax) * 0.5;
        let half = ((bmax - bmin) * 0.5)
            .max(Vec3A::splat(1.0))
            .max_element();
        let root_min = center - Vec3A::splat(half);
        let root_max = center + Vec3A::splat(half);

        self.nodes.push(OctreeNode::new_leaf(root_min, root_max));

        for (idx, &pos) in positions.iter().enumerate() {
            self.insert_iter(idx as u32, pos, positions);
        }
    }

    // ------------------------------------------------------------------
    // Iterative insert
    // ------------------------------------------------------------------
    fn insert_iter(&mut self, item_idx: u32, pos: Vec3A, positions: &[Vec3A]) {
        self.insert_stack.clear();
        self.insert_stack.push((0u32, item_idx, pos));

        while let Some((node_idx, item_idx, pos)) = self.insert_stack.pop() {
            // 1. Update center-of-mass and mass (scoped borrow released immediately).
            {
                let node = &mut self.nodes[node_idx as usize];
                let new_mass = node.mass + 1.0;
                node.center_of_mass = (node.center_of_mass * node.mass + pos) / new_mass;
                node.mass = new_mass;
            }

            // 2. Read state before any further mutations.
            let (cur_node_index, is_leaf) = {
                let node = &self.nodes[node_idx as usize];
                (node.node_index, node.is_leaf())
            };

            if cur_node_index == EMPTY && is_leaf {
                // Empty leaf — store item here and continue.
                self.nodes[node_idx as usize].node_index = item_idx;
                continue;
            }

            // Occupied leaf or internal node.
            // If occupied leaf: displace existing item into a child octant first.
            if cur_node_index != EMPTY {
                self.nodes[node_idx as usize].node_index = EMPTY;
                let existing_pos = positions[cur_node_index as usize];
                let oct = self.get_octant(node_idx, existing_pos);
                let child = self.get_or_create_child(node_idx, oct);
                self.insert_stack.push((child, cur_node_index, existing_pos));
            }

            // Insert the new item into its octant.
            let oct = self.get_octant(node_idx, pos);
            let child = self.get_or_create_child(node_idx, oct);
            self.insert_stack.push((child, item_idx, pos));
        }
    }

    // ------------------------------------------------------------------
    // Helpers — inlined for the hot insertion path
    // ------------------------------------------------------------------

    #[inline(always)]
    fn get_octant(&self, node_idx: u32, pos: Vec3A) -> usize {
        let n = &self.nodes[node_idx as usize];
        let center = (n.bounds_min + n.bounds_max) * 0.5;
        // glam 0.33 BVec3A is a bitmask type with no .x/.y/.z fields.
        // Scalar comparisons are equally fast and autovectorised by the compiler.
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

        // Copy bounds before push() to avoid aliasing after potential realloc.
        let (p_min, p_max) = {
            let p = &self.nodes[parent_idx as usize];
            (p.bounds_min, p.bounds_max)
        };
        let center = (p_min + p_max) * 0.5;

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
        new_idx
    }

    // ------------------------------------------------------------------
    // Iterative Barnes-Hut repulsion traversal
    // ------------------------------------------------------------------
    //
    // WHY iterative: recursive descent prevents LLVM/wasm-opt from
    // pipelining the inner arithmetic and limits stack depth for large graphs.
    // The reusable `traversal_stack` eliminates per-frame heap allocations.

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
            // Copy out all scalar fields we need, releasing the borrow
            // before we mutate traversal_stack (different field, but explicit
            // scoping keeps this unambiguous for the borrow checker).
            let (mass, com, bounds_size, node_index, is_leaf, children) = {
                let n = &self.nodes[node_idx as usize];
                (
                    n.mass,
                    n.center_of_mass,
                    (n.bounds_max.x - n.bounds_min.x).abs(),
                    n.node_index,
                    n.is_leaf(),
                    n.children, // [u32;8] — Copy, 32 bytes on stack
                )
            };

            if mass == 0.0 {
                continue;
            }

            let delta = pos - com;
            let dist_sq = delta.length_squared().max(1.0);
            let dist = dist_sq.sqrt();

            if is_leaf || (bounds_size / dist) < theta {
                // Treat this cell as a single body.
                if node_index != self_item_idx {
                    let f_mag = (repulsion_const * mass) / (dist_sq * dist);
                    force_acc += delta * f_mag;
                }
            } else {
                // Subdivide — push non-empty children for traversal.
                for &child_idx in &children {
                    if child_idx != EMPTY {
                        self.traversal_stack.push(child_idx);
                    }
                }
            }
        }

        force_acc
    }
}

// ---------------------------------------------------------------------------
// PhysicsEngine
// ---------------------------------------------------------------------------
//
// `flat_positions` has been removed.  Positions are stored only as Vec<Vec3A>
// and exposed to JS via `positions_ptr()` / `positions_len()` at Vec3A stride
// (4 f32s per node: x, y, z, pad).  This eliminates the O(N) `sync_flat_buffer`
// scatter copy that previously ran on every physics step.

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

        // Fibonacci sphere — uniform initial spread avoids symmetry-breaking
        // degeneracies that would require many extra steps to resolve.
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

    /// Accept stride-3 (packed xyz) positions from JavaScript.
    /// Called during drag and on graph re-init.
    pub fn set_positions_flat(&mut self, flat_in: &[f32]) {
        let count = self.positions.len().min(flat_in.len() / 3);
        for i in 0..count {
            self.positions[i] =
                Vec3A::new(flat_in[i * 3], flat_in[i * 3 + 1], flat_in[i * 3 + 2]);
        }
        self.kinetic_energy = 1.0;
    }

    /// Raw pointer to the Vec<Vec3A> data.
    /// Layout per element: [x: f32, y: f32, z: f32, _pad: f32].
    /// JavaScript reads with stride 4: positions[i*4], [i*4+1], [i*4+2].
    #[inline]
    pub fn positions_ptr(&self) -> *const f32 {
        self.positions.as_ptr() as *const f32
    }

    /// Number of f32 values in the slice starting at `positions_ptr`.
    /// Equals node_count × 4 (Vec3A stride).
    #[inline]
    pub fn positions_len(&self) -> usize {
        self.positions.len() * 4
    }

    /// Advance the simulation by one step.
    /// Returns `false` when the simulation has converged (kinetic energy below alpha_min).
    pub fn step(&mut self) -> bool {
        let n = self.positions.len();
        if n == 0 || self.kinetic_energy < self.params.alpha_min {
            return false;
        }

        // ---- Reset force accumulators ----------------------------------------
        for f in self.forces.iter_mut() {
            *f = Vec3A::ZERO;
        }

        // ---- Repulsion -------------------------------------------------------
        if n > OCTREE_THRESHOLD {
            // Barnes-Hut O(N log N) — octree is rebuilt every frame because
            // positions change every frame.
            self.octree.rebuild(&self.positions);
            for i in 0..n {
                let pos_i = self.positions[i]; // Copy before &mut self.octree borrow
                let rep = self.octree.compute_repulsion_iter(
                    pos_i,
                    i as u32,
                    self.params.repulsion,
                    self.params.theta,
                );
                self.forces[i] += rep;
            }
        } else {
            // O(N²) brute-force — wasm-opt + -C target-feature=+simd128 will
            // autovectorise this tight loop using WASM SIMD v128 instructions.
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

        // ---- Spring attraction on edges --------------------------------------
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

        // ---- Gravity (pull toward origin) -----------------------------------
        {
            let g = self.params.gravity;
            for i in 0..n {
                self.forces[i] -= self.positions[i] * g;
            }
        }

        // ---- Semi-implicit Euler integration --------------------------------
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
                // Clamp velocity without computing sqrt when unnecessary.
                self.velocities[i] = if v_sq > max_v_sq {
                    v * (max_v / v_sq.sqrt())
                } else {
                    v
                };
                self.positions[i] += self.velocities[i] * dt;
            }

            self.kinetic_energy = total_v_sq / (n as f32);
        }

        // No sync_flat_buffer — JS reads positions directly via positions_ptr().
        true
    }
}
