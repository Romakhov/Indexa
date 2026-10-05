declare module "*.wasm" {
	const bytes: Uint8Array;
	export default bytes;
}

declare const __WORKER_CODE__: string;
declare const __SPIKE__: boolean;
