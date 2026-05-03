// Copies @xenova/transformers dist (ESM bundle + ONNX wasm runtimes) into
// vendor/transformers/ so the extension can ship them as web-accessible
// resources. Runs as `npm run vendor:transformers` (also wired via postinstall).
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "node_modules", "@xenova", "transformers", "dist");
const dst = join(root, "vendor", "transformers");

mkdirSync(dst, { recursive: true });

const wanted = (name) =>
  name === "transformers.min.js" || name.endsWith(".wasm");

let n = 0;
for (const name of readdirSync(src)) {
  if (!wanted(name)) continue;
  copyFileSync(join(src, name), join(dst, name));
  n++;
}
console.log(`[vendor:transformers] copied ${n} files into vendor/transformers`);
