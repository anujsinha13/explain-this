import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const extension = await esbuild.context({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});

const cli = await esbuild.context({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});

if (watch) {
  await Promise.all([extension.watch(), cli.watch()]);
} else {
  await Promise.all([extension.rebuild(), cli.rebuild()]);
  await Promise.all([extension.dispose(), cli.dispose()]);
}
