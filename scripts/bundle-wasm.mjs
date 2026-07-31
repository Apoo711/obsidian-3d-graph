import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import esbuild from "esbuild";

console.log("Building Rust WASM package...");
execSync("wasm-pack build --target web --release", {
	cwd: path.resolve("crates/graph-physics"),
	stdio: "inherit",
});

console.log("Inlining WASM binary to Base64...");
const wasmPath = path.resolve("crates/graph-physics/pkg/graph_physics_bg.wasm");
const wasmBuffer = fs.readFileSync(wasmPath);
const wasmBase64 = wasmBuffer.toString("base64");

fs.writeFileSync(
	path.resolve("src/physics/wasm-data.ts"),
	`// Auto-generated WASM binary Base64\nconst wasmBase64 = "${wasmBase64}";\nexport default wasmBase64;\n`,
);

console.log("Bundling Physics Web Worker...");
const workerBuild = await esbuild.build({
	entryPoints: ["src/physics/physics-worker.ts"],
	bundle: true,
	write: false,
	format: "iife",
	target: "es2018",
	minify: true,
});

const workerCode = workerBuild.outputFiles[0].text;
fs.writeFileSync(
	path.resolve("src/physics/worker-data.ts"),
	`// Auto-generated Physics Worker Code\nconst workerCode = ${JSON.stringify(workerCode)};\nexport default workerCode;\n`,
);

console.log("WASM & Physics Worker bundled successfully!");
