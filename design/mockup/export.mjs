// Builds the mockup into one self-contained HTML file that opens by double-click
// (no server, works offline): design/mockup/dist/MKVBatchMux-mockup.html
//   node design/mockup/export.mjs
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import { build } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const tmp = join(root, "dist", ".build");

await build({
  root,
  base: "./",
  configFile: false,
  logLevel: "warn",
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  build: { outDir: tmp, emptyOutDir: true, assetsInlineLimit: Infinity, modulePreload: false },
});

const assets = join(tmp, "assets");
let html = readFileSync(join(tmp, "index.html"), "utf8");
for (const f of readdirSync(assets)) {
  const body = readFileSync(join(assets, f), "utf8");
  if (f.endsWith(".css")) {
    html = html.replace(new RegExp(`<link[^>]*${f}[^>]*>`), () => `<style>${body}</style>`);
  } else if (f.endsWith(".js")) {
    html = html.replace(new RegExp(`<script[^>]*${f}[^>]*></script>`), () => `<script type="module">${body.replaceAll("</script", "<\\/script")}</script>`);
  }
}
const out = join(root, "dist", "MKVBatchMux-mockup.html");
writeFileSync(out, html);
rmSync(tmp, { recursive: true, force: true });
console.log(`${out} (${(html.length / 1024).toFixed(0)} KB)`);
