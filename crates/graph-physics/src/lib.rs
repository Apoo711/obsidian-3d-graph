mod physics;

use physics::{PhysicsEngine, SimulationParams};
use serde_wasm_bindgen::{from_value, to_value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct GraphPhysicsWasm {
    engine: PhysicsEngine,
}

#[wasm_bindgen]
impl GraphPhysicsWasm {
    #[wasm_bindgen(constructor)]
    pub fn new(
        node_count: usize,
        edges_flat: &[u32],
        params_val: JsValue,
    ) -> Result<GraphPhysicsWasm, JsValue> {
        let params: SimulationParams = if params_val.is_undefined() || params_val.is_null() {
            SimulationParams::default()
        } else {
            from_value(params_val).map_err(|e| JsValue::from_str(&e.to_string()))?
        };

        let engine = PhysicsEngine::new(node_count, edges_flat.to_vec(), params);
        Ok(GraphPhysicsWasm { engine })
    }

    pub fn set_params(&mut self, params_val: JsValue) -> Result<(), JsValue> {
        let params: SimulationParams =
            from_value(params_val).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.engine.params = params;
        self.engine.kinetic_energy = 1.0;
        Ok(())
    }

    pub fn get_params(&self) -> Result<JsValue, JsValue> {
        to_value(&self.engine.params).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn set_positions(&mut self, positions_flat: &[f32]) {
        self.engine.set_positions_flat(positions_flat);
    }

    pub fn step(&mut self) -> bool {
        self.engine.step()
    }

    pub fn step_n(&mut self, count: u32) -> bool {
        let mut active = false;
        for _ in 0..count {
            if self.engine.step() {
                active = true;
            } else {
                break;
            }
        }
        active
    }

    pub fn energy(&self) -> f32 {
        self.engine.kinetic_energy
    }

    pub fn is_converged(&self) -> bool {
        self.engine.kinetic_energy < self.engine.params.alpha_min
    }

    pub fn positions_ptr(&self) -> *const f32 {
        self.engine.positions_ptr()
    }

    pub fn positions_len(&self) -> usize {
        self.engine.positions_len()
    }

    pub fn positions_stride(&self) -> usize {
        4
    }

    pub fn shortest_path_hops(&self, start_node: u32) -> Vec<i32> {
        self.engine.shortest_path_hops(start_node)
    }

    pub fn connected_components(&self) -> Vec<u32> {
        self.engine.connected_components()
    }

    pub fn node_degrees(&self) -> Vec<u32> {
        self.engine.node_degrees()
    }

    pub fn rebuild_spatial_hash(&mut self, cell_size: f32) {
        self.engine.rebuild_spatial_hash(cell_size);
    }

    pub fn query_radius(&self, cx: f32, cy: f32, cz: f32, radius: f32) -> Vec<u32> {
        self.engine
            .query_radius(glam::Vec3A::new(cx, cy, cz), radius)
    }

    pub fn find_nearest(&self, px: f32, py: f32, pz: f32, max_dist: f32) -> Option<u32> {
        self.engine
            .find_nearest(glam::Vec3A::new(px, py, pz), max_dist)
    }
}
