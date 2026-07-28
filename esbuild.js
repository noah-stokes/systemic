const esbuild = require("esbuild");

const production = process.argv.includes("--production");

const builds = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    minify: production,
    sourcemap: !production,
    target: "node20",
  },
  {
    entryPoints: ["src/webview/index.tsx"],
    outdir: "dist",
    entryNames: "webview",
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    format: "esm",
    splitting: true,
    platform: "browser",
    minify: production,
    sourcemap: !production,
    target: "es2022",
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        production ? "production" : "development"
      ),
    },
  },
];

async function main() {
  if (process.argv.includes("--watch")) {
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    console.log("Watching extension and webview…");
    return;
  }
  await Promise.all(builds.map((options) => esbuild.build(options)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
