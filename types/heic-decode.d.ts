// heic-decode ships no type declarations (CJS, wasm libheif wrapper).
// Mirrors lib.js: decode.all() yields LAZY handles — pixels only after
// per-image decode(); the returned array carries a non-enumerable dispose().
declare module "heic-decode" {
  export interface HeifImageHandle {
    width: number;
    height: number;
    decode(): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  }
  export interface HeifImageHandles extends Array<HeifImageHandle> {
    dispose(): void;
  }
  function decode(opts: { buffer: Buffer | Uint8Array }): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  namespace decode {
    function all(opts: { buffer: Buffer | Uint8Array }): Promise<HeifImageHandles>;
  }
  export default decode;
}
