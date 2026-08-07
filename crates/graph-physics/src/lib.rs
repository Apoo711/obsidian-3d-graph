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
}
