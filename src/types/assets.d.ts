declare module "*.wasm" {
	const bytes: Uint8Array;
	export default bytes;
}

declare const __WORKER_CODE__: string;
declare const __ANALYSIS_WORKER_CODE__: string;
declare const __SPIKE__: boolean;
declare const __ORT_FLAVOUR__: "wasm" | "webgpu";

declare module "indexa-ort-wasm" {
	const bytes: Uint8Array;
	export default bytes;
}
declare module "indexa-ort" {
	export * from "onnxruntime-web";
}
