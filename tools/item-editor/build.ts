// Bundles the item editor (plain TypeScript, no framework) into tools/item-editor/dist.
// The game server serves it at /editor/. Usage: node tools/item-editor/build.ts [--watch]

import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");
const watch = process.argv.includes("--watch");

mkdirSync(dist, { recursive: true });
const copyStatic = () => cpSync(join(here, "public"), dist, { recursive: true });
copyStatic();

const options: esbuild.BuildOptions = {
  entryPoints: { editor: join(here, "src", "main.ts"), login: join(here, "src", "login.ts") },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: dist,
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  plugins: [{ name: "copy-static", setup(b) { b.onEnd(() => copyStatic()); } }],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[editor] watching…");
} else {
  await esbuild.build(options);
}
