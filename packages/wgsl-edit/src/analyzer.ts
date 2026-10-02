import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

export interface WgslEditAnalyzerOptions {
  /** URL path to serve wgsl-analyzer from; match the `lsp` attribute
   *  (default: `/wgsl-analyzer/`). */
  base?: string;
  /** Send the COOP/COEP headers wgsl-analyzer needs from the dev and preview
   *  servers (default: true). Production hosts must send them too. */
  isolate?: boolean;
}

/** wgsl-analyzer-web requires these to sit side by side under exactly these names. */
const assetNames = ["worker.js", "wgsl_analyzer.js", "wgsl_analyzer.wasm"];

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** Vite plugin for `<wgsl-edit lsp>`: serves the wgsl-analyzer worker and wasm
 *  in dev, emits them into builds, and makes the page cross-origin isolated. */
export default function wgslEditAnalyzer(
  options?: WgslEditAnalyzerOptions,
): Plugin {
  const base = `/${(options?.base ?? "wgsl-analyzer").replace(/^\/|\/$/g, "")}/`;
  const headers = options?.isolate === false ? undefined : isolationHeaders;
  const workerUrl = import.meta.resolve("wgsl-analyzer-web/assets/worker.js");
  const assetDir = path.dirname(fileURLToPath(workerUrl));

  return {
    name: "wgsl-edit-analyzer",
    config: () => headers && { server: { headers }, preview: { headers } },
    configureServer(server) {
      server.middlewares.use(serveAssets(base, assetDir, headers));
    },
    async generateBundle() {
      for (const name of assetNames) {
        const source = await readFile(path.join(assetDir, name));
        const fileName = base.slice(1) + name;
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}

function serveAssets(
  base: string,
  assetDir: string,
  headers: Record<string, string> | undefined,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url?.split("?")[0] ?? "";
    const name = url.startsWith(base) ? url.slice(base.length) : "";
    if (!assetNames.includes(name)) return next();
    readFile(path.join(assetDir, name)).then(
      body => sendAsset(res, name, body, headers),
      next,
    );
  };
}

function sendAsset(
  res: ServerResponse,
  name: string,
  body: Buffer,
  headers: Record<string, string> | undefined,
): void {
  // pthread workers need the isolation headers on their own scripts too
  for (const [key, value] of Object.entries(headers ?? {})) {
    res.setHeader(key, value);
  }
  const wasm = name.endsWith(".wasm");
  res.setHeader("Content-Type", wasm ? "application/wasm" : "text/javascript");
  res.end(body);
}
