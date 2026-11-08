/**
 * Builds dist/: ES modules with source maps (Bun), and declarations (TypeScript) with explicit
 * `.js` extensions, so they resolve under `moduleResolution: "nodenext"` too. Dependencies and
 * peers stay external.
 * Also dist/mira.js, the script-tag bundle (IIFE, minified), with its size.
 */
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
    ...(banner ? { banner } : {}),
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};
for (const entry of client) await build([entry], '"use client";');
await build(rest);

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

const script = await Bun.build({
  entrypoints: [`${dir}/src/snippet.ts`],
  outdir: `${dir}/dist`,
  naming: "mira.js",
  format: "iife",
  target: "browser",
  minify: true,
});
if (!script.success) {
  for (const log of script.logs) console.error(log);
  process.exit(1);
}
const bytes = await Bun.file(`${dir}/dist/mira.js`).bytes();
const kb = (size: number) => `${(size / 1024).toFixed(2)} kB`;
console.log(
  `dist/mira.js  ${kb(bytes.length)} min  ${kb(Bun.gzipSync(bytes, { level: 9 }).length)} gzip`,
);

console.log(`✓ built ${manifest.name}`);
