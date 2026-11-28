/**
 * Builds dist/: ES modules with source maps (Bun), and declarations (TypeScript) with explicit
 * `.js` extensions, so they resolve under `moduleResolution: "nodenext"` too. Dependencies and
 * peers stay external.
 * Also dist/mira.js, the script-tag bundle (IIFE, minified), with its size, and the recorder:
 * dist/mira-recorder.js for the script tag and dist/replay/recorder.js, the chunk `createMira`
 * imports dynamically. Both bundle `@rrweb/record`, so the package has no dependency on it and
 * records with exactly the release whose defaults its tests pin.
 */
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const dir = import.meta.dir;
const entries = ["src/index.ts"];
const manifest = await Bun.file(`${dir}/package.json`).json();
const external: string[] = manifest.mira?.external ?? [];

await rm(`${dir}/dist`, { recursive: true, force: true });

// "use client" entries are built one by one, so the directive is the first line of their file.
const client: string[] = [];
const rest: string[] = [];
for (const entry of entries) {
  const head = (await Bun.file(`${dir}/${entry}`).text()).trimStart();
  (head.startsWith('"use client"') ? client : rest).push(`${dir}/${entry}`);
}
/**
 * The npm entry imports the recorder and the signals detector at runtime only: each stays a chunk
 * of its own (built below).
 */
const recorderApart: BunPlugin = {
  name: "recorder-apart",
  setup(bundler) {
    bundler.onResolve({ filter: /^\.\/replay\/recorder$/ }, () => ({
      path: "./replay/recorder.js",
      external: true,
    }));
    bundler.onResolve({ filter: /^\.\/signals\/detector$/ }, () => ({
      path: "./signals/detector.js",
      external: true,
    }));
  },
};
const build = async (entrypoints: string[], banner?: string) => {
  if (!entrypoints.length) return;
  const result = await Bun.build({
    entrypoints,
    root: `${dir}/src`,
    outdir: `${dir}/dist`,
    format: "esm",
    target: "browser",
    packages: "external",
    external,
    splitting: entrypoints.length > 1,
    sourcemap: "linked",
    plugins: [recorderApart],
    ...(banner ? { banner } : {}),
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};
for (const entry of client) await build([entry], '"use client";');
await build(rest);

/** rrweb's license travels with the files that contain it. */
const RRWEB_NOTICE =
  "/*! Contains @rrweb/record (https://github.com/rrweb-io/rrweb), MIT License, Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors) and SmartX Inc. */";
const recorderChunk = await Bun.build({
  entrypoints: [`${dir}/src/replay/recorder.ts`],
  root: `${dir}/src`,
  outdir: `${dir}/dist`,
  format: "esm",
  target: "browser",
  external: ["@mirafive/protocol"],
  sourcemap: "linked",
  banner: RRWEB_NOTICE,
});
if (!recorderChunk.success) {
  for (const log of recorderChunk.logs) console.error(log);
  process.exit(1);
}

// The signals detector for npm: its own chunk, like the recorder's.
const signalsChunk = await Bun.build({
  entrypoints: [`${dir}/src/signals/detector.ts`],
  root: `${dir}/src`,
  outdir: `${dir}/dist`,
  format: "esm",
  target: "browser",
  external: ["@mirafive/protocol"],
  sourcemap: "linked",
});
if (!signalsChunk.success) {
  for (const log of signalsChunk.logs) console.error(log);
  process.exit(1);
}

const tsc = Bun.spawn([`${dir}/node_modules/.bin/tsc`, "-p", `${dir}/tsconfig.build.json`], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tsc.exited) !== 0) process.exit(1);

// `from "./mira"` → `from "./mira.js"`; comment lines hold examples, not imports.
for await (const file of new Bun.Glob("**/*.d.ts").scan({ cwd: `${dir}/dist` })) {
  const path = `${dir}/dist/${file}`;
  const folder = dirname(path);
  const text = (await readFile(path, "utf8"))
    .split("\n")
    .map((line) =>
      /^\s*(\*|\/\/|\/\*)/.test(line)
        ? line
        : line.replace(
            /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']*)\2/g,
            (match, prefix: string, quote: string, specifier: string) => {
              if (/\.(js|json)$/.test(specifier)) return match;
              if (existsSync(`${folder}/${specifier}.d.ts`))
                return `${prefix}${quote}${specifier}.js${quote}`;
              if (existsSync(`${folder}/${specifier}/index.d.ts`))
                return `${prefix}${quote}${specifier}/index.js${quote}`;
              throw new Error(`cannot resolve ${specifier} in ${file}`);
            },
          ),
    )
    .join("\n");
  await writeFile(path, text);
}

// The recorder for the script tag, first: mira.js carries its integrity hash, so a page that pins
// mira.js with Subresource Integrity pins the recorder with it.
const recorder = await Bun.build({
  entrypoints: [`${dir}/src/replay/recorder-script.ts`],
  outdir: `${dir}/dist`,
  naming: "mira-recorder.js",
  format: "iife",
  target: "browser",
  minify: true,
  banner: RRWEB_NOTICE,
});
if (!recorder.success) {
  for (const log of recorder.logs) console.error(log);
  process.exit(1);
}
const recorderBytes = await Bun.file(`${dir}/dist/mira-recorder.js`).bytes();
const integrity = `sha384-${new Bun.CryptoHasher("sha384").update(recorderBytes).digest("base64")}`;

// The signals detector for the script tag, before mira.js too, for the same reason.
const signalsScript = await Bun.build({
  entrypoints: [`${dir}/src/signals/signals-script.ts`],
  outdir: `${dir}/dist`,
  naming: "mira-signals.js",
  format: "iife",
  target: "browser",
  minify: true,
});
if (!signalsScript.success) {
  for (const log of signalsScript.logs) console.error(log);
  process.exit(1);
}
const signalsBytes = await Bun.file(`${dir}/dist/mira-signals.js`).bytes();
const signalsIntegrity = `sha384-${new Bun.CryptoHasher("sha384").update(signalsBytes).digest("base64")}`;

const script = await Bun.build({
  entrypoints: [`${dir}/src/snippet.ts`],
  outdir: `${dir}/dist`,
  naming: "mira.js",
  format: "iife",
  target: "browser",
  minify: true,
  define: {
    MIRA_RECORDER_INTEGRITY: JSON.stringify(integrity),
    MIRA_SIGNALS_INTEGRITY: JSON.stringify(signalsIntegrity),
  },
});
if (!script.success) {
  for (const log of script.logs) console.error(log);
  process.exit(1);
}

// Pixel mode for Shopify custom pixels: its own file, so the script every site loads stays small.
const pixel = await Bun.build({
  entrypoints: [`${dir}/src/shopify/pixel-snippet.ts`],
  outdir: `${dir}/dist`,
  naming: "mira-shopify-pixel.js",
  format: "iife",
  target: "browser",
  minify: true,
});
if (!pixel.success) {
  for (const log of pixel.logs) console.error(log);
  process.exit(1);
}
const kb = (size: number) => `${(size / 1024).toFixed(2)} kB`;
/**
 * The other files' gzip budgets; CI checks `mira.js` (its budget is in ci.yml). The recorder is
 * fetched only for a recorded session, after the page has loaded.
 */
const BUDGETS: Record<string, number> = {
  "mira-shopify-pixel.js": 12_288,
  "mira-recorder.js": 40_960,
  "mira-signals.js": 8_192,
};
for (const file of ["mira.js", "mira-shopify-pixel.js", "mira-recorder.js", "mira-signals.js"]) {
  const bytes = await Bun.file(`${dir}/dist/${file}`).bytes();
  const gzip = Bun.gzipSync(bytes, { level: 9 }).length;
  console.log(`dist/${file}  ${kb(bytes.length)} min  ${kb(gzip)} gzip (${gzip} bytes)`);
  const budget = BUDGETS[file];
  if (budget && gzip > budget) {
    console.error(`${file} is ${gzip} bytes gzip, over its budget of ${budget}`);
    process.exit(1);
  }
}
// The script tag must not carry the recorder or the signals detector.
const base = await Bun.file(`${dir}/dist/mira.js`).text();
if (base.includes("rr-block")) {
  console.error("dist/mira.js contains the recorder");
  process.exit(1);
}
if (base.includes("$rage_click")) {
  console.error("dist/mira.js contains the signals detector");
  process.exit(1);
}

console.log(`✓ built ${manifest.name}`);
