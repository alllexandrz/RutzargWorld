// Bundles the Phaser client with esbuild into client/dist and copies static files.
// Usage: node scripts/build-client.ts [--watch]

import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "client", "dist");
const watch = process.argv.includes("--watch");

mkdirSync(dist, { recursive: true });
const copyStatic = () => cpSync(join(root, "client", "public"), dist, { recursive: true });
copyStatic();

const options: esbuild.BuildOptions = {
  entryPoints: [join(root, "client", "src", "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(dist, "game.js"),
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  define: { CANVAS_RENDERER: "true", WEBGL_RENDERER: "true" },
  plugins: [{ name: "copy-static", setup(b) { b.onEnd(() => copyStatic()); } }],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[build] watching client…");
} else {
  await esbuild.build(options);
}
