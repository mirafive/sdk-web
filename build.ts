/**
 * Builds dist/: ES modules with source maps (Bun), and declarations (TypeScript) with explicit
 * `.js` extensions, so they resolve under `moduleResolution: "nodenext"` too. Dependencies and
 * peers stay external.
 * Also the script-tag files (IIFE, bundled by Bun, minified by terser), with their sizes:
 * dist/mira.js and its siblings, each loaded only on a page that needs it (`mira-consent.js`,
 * `mira-shopify.js`, `mira-recorder.js`, `mira-signals.js`), and pixel mode's
 * `mira-shopify-pixel.js`. The recorder is also dist/replay/recorder.js, the chunk `createMira`
 * imports dynamically. Both bundle `@rrweb/record`, so the package has no dependency on it and
 * records with exactly the release whose defaults its tests pin.
 */
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { minify } from "terser";

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

/**
 * One script-tag file: an IIFE bundled by Bun and minified by terser, whose output is about 6%
 * smaller than Bun's own, gzip and brotli alike. Comments starting with `!` (licenses) stay.
 * Returns its Subresource Integrity hash.
 */
async function scriptFile(
  entry: string,
  naming: string,
  options: { banner?: string; define?: Record<string, string> } = {},
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${dir}/src/${entry}`],
    format: "iife",
    target: "browser",
    ...options,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const output = result.outputs[0];
  if (!output) process.exit(1);
  const { code } = await minify(await output.text(), {
    ecma: 2020,
    compress: { ecma: 2020, passes: 2 },
    mangle: true,
    format: { ecma: 2020, comments: /^!/ },
  });
  if (!code) process.exit(1);
  const bytes = new TextEncoder().encode(code);
  await Bun.write(`${dir}/dist/${naming}`, bytes);
  return `sha384-${new Bun.CryptoHasher("sha384").update(bytes).digest("base64")}`;
}

// The siblings first: mira.js carries their integrity hashes, so a page that pins mira.js with
// Subresource Integrity pins every file it loads with it.
const integrity = {
  recorder: await scriptFile("replay/recorder-script.ts", "mira-recorder.js", {
    banner: RRWEB_NOTICE,
  }),
  signals: await scriptFile("signals/signals-script.ts", "mira-signals.js"),
  consent: await scriptFile("consent/consent-script.ts", "mira-consent.js"),
  shopify: await scriptFile("shopify/shopify-script.ts", "mira-shopify.js"),
};
await scriptFile("snippet.ts", "mira.js", {
  define: { MIRA_INTEGRITY: JSON.stringify(integrity) },
});
// Pixel mode for Shopify custom pixels: its own file, so the script every site loads stays small.
await scriptFile("shopify/pixel-snippet.ts", "mira-shopify-pixel.js");

const kb = (size: number) => `${(size / 1024).toFixed(2)} kB`;
/**
 * The other files' gzip budgets; CI checks `mira.js` (its budget is in ci.yml). The siblings are
 * fetched only on a page that needs them, the recorder only for a recorded session, after the page
 * has loaded.
 */
const BUDGETS: Record<string, number> = {
  "mira-consent.js": 3_072,
  "mira-shopify.js": 2_048,
  "mira-shopify-pixel.js": 9_216,
  "mira-recorder.js": 40_960,
  "mira-signals.js": 8_192,
};
for (const file of ["mira.js", ...Object.keys(BUDGETS)]) {
  const bytes = await Bun.file(`${dir}/dist/${file}`).bytes();
  const gzip = Bun.gzipSync(bytes, { level: 9 }).length;
  console.log(`dist/${file}  ${kb(bytes.length)} min  ${kb(gzip)} gzip (${gzip} bytes)`);
  const budget = BUDGETS[file];
  if (budget && gzip > budget) {
    console.error(`${file} is ${gzip} bytes gzip, over its budget of ${budget}`);
    process.exit(1);
  }
}
/** Text only a part has, so a file that must not carry the part must not contain it. */
const MARKS = {
  "the recorder": "rr-block",
  "the signals detector": "$rage_click",
  "the CMP adapters' subscriptions": "CookiebotOnConsentReady",
  "Shopify mode's parts": "consent-tracking-api",
  autocapture: "$outbound_click",
};
const FORBIDDEN: Record<string, (keyof typeof MARKS)[]> = {
  "mira.js": [
    "the recorder",
    "the signals detector",
    "the CMP adapters' subscriptions",
    "Shopify mode's parts",
  ],
  "mira-shopify-pixel.js": [
    "the recorder",
    "the signals detector",
    "the CMP adapters' subscriptions",
    "Shopify mode's parts",
    "autocapture",
  ],
};
for (const [file, parts] of Object.entries(FORBIDDEN)) {
  const text = await Bun.file(`${dir}/dist/${file}`).text();
  for (const part of parts) {
    if (text.includes(MARKS[part])) {
      console.error(`dist/${file} contains ${part}`);
      process.exit(1);
    }
  }
}

console.log(`✓ built ${manifest.name}`);
