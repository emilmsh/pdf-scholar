// The few parts of tesseract.js-core's emscripten module that ocr.worker.ts
// calls. The package ships no typings; these are written against its
// WebIDL binding (TessBaseAPI) and checked by scripts/test-ocr.mjs, which
// drives the same calls in Node.
declare module 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js' {
  export interface TessBaseApi {
    Init(datapath: string | null, language: string, oem: number): number
    SetVariable(name: string, value: string): boolean
    /** Reads the image written to /input in the module's file system; 1 is failure */
    SetImageFile(exif: number, angle: number): number
    SetSourceResolution(ppi: number): void
    Recognize(monitor: null): number
    GetTSVText(page: number): string
    Clear(): void
    End(): void
  }
  export interface TessModule {
    FS: {
      writeFile(path: string, data: Uint8Array | string): void
      unlink(path: string): void
    }
    TessBaseAPI: new () => TessBaseApi
  }
  const TesseractCore: (options: { wasmBinary?: Uint8Array }) => Promise<TessModule>
  export default TesseractCore
}
