// Worker thread entry point for `renderWithPierreInWorker`. Each build of the executable must list this file.
import { renderWithPierre, type PierreOptions } from "./pierre.ts";

export interface PierreRequest {
  id: number;
  patch: string;
  options: PierreOptions;
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent<PierreRequest>) => {
  const { id, patch, options } = event.data;
  try {
    self.postMessage({ id, result: await renderWithPierre(patch, options) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
