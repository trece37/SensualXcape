import { readFile, mkdir, copyFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDemo, assertDemoOutput } from './build-demo.mjs';
import { buildForum, assertForumOutput } from './build-forum.mjs';
import { buildLive } from './build-live.mjs';

export const V1_SOURCE_COMMIT = '1a645827aa5c5b92b998a5373810bdfd3a4dbfbb';
export const V1_FILES = Object.freeze(['.nojekyll', 'assets/v11/portal-unicorn.png', 'demo.css', 'demo.js', 'index.html']);
const V1_DIRECTORIES = new Set(['assets', 'assets/v11']);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The frozen site is reviewed output from the original source commit, not a second app build. */
export async function verifyFrozenV1({ root = projectRoot, site = join(root, 'versions', 'v1', 'site'), manifestPath = join(root, 'versions', 'v1', 'manifest.json') } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.source_commit !== V1_SOURCE_COMMIT) throw new Error('Frozen V1 source commit does not match the original public version.');
  if (JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify([...V1_FILES].sort())) throw new Error('Frozen V1 manifest contains missing or unexpected files.');
  const metadata = await lstat(site);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Frozen V1 must be an ordinary directory.');
  const found = [];
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name), info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Frozen V1 contains a symbolic link: ${relative}`);
      if (info.isDirectory()) {
        if (!V1_DIRECTORIES.has(relative)) throw new Error(`Frozen V1 contains an unexpected directory: ${relative}`);
        await inspect(absolute, relative);
      } else if (!info.isFile() || info.nlink > 1 || !V1_FILES.includes(relative)) {
        throw new Error(`Frozen V1 contains an unexpected or linked file: ${relative}`);
      } else {
        const bytes = await readFile(absolute), expected = manifest.files[relative];
        if (expected.sha256 !== digest(bytes) || expected.size !== bytes.length) throw new Error(`Frozen V1 fingerprint changed: ${relative}`);
        found.push(relative);
      }
    }
  }
  await inspect(site);
  if (found.length !== V1_FILES.length) throw new Error('Frozen V1 is incomplete.');
  return { site, manifest, files: found.sort() };
}

/** Refuse unknown generated files before copying either version. */
export async function assertPagesOutput(output) {
  let metadata;
  try { metadata = await lstat(output); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Pages output must be an ordinary directory.');
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name), info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Review Pages output: symbolic link ${relative}`);
      if (relative === 'foro') {
        if (!info.isDirectory()) throw new Error('Pages forum output must be an ordinary directory.');
        await assertForumOutput(absolute);
      } else if (relative === 'v2' || relative === 'demo') {
        if (!info.isDirectory()) throw new Error('Pages v2 output must be an ordinary directory.');
        await assertDemoOutput(absolute);
      } else if (info.isDirectory()) {
        if (!V1_DIRECTORIES.has(relative)) throw new Error(`Review Pages output: unexpected directory ${relative}`);
        await inspect(absolute, relative);
      } else if (!info.isFile() || info.nlink > 1 || !V1_FILES.includes(relative)) {
        throw new Error(`Review Pages output: unexpected or linked file ${relative}`);
      }
    }
  }
  await inspect(output);
}

/** Publish the unchanged V1 at the original URL and the current web app under /v2/. */
export async function buildPages({ root = projectRoot, output = join(root, 'dist-pages'), dependencyRoot = process.env.SX_DEMO_DEPS_ROOT || root } = {}) {
  const frozen = await verifyFrozenV1({ root });
  await assertPagesOutput(output);
  for (const relative of frozen.files) {
    const destination = join(output, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(frozen.site, relative), destination);
  }
  const v2Output = join(output, 'v2');
  await buildLive({ root, output: v2Output, dependencyRoot });
  await buildDemo({ root, output: join(output, 'demo'), dependencyRoot });
  await buildForum({ root, output: join(output, 'foro'), dependencyRoot });
  // Recheck destination bytes too: no transform, banner or selector may alter V1.
  for (const relative of frozen.files) {
    const bytes = await readFile(join(output, relative));
    if (digest(bytes) !== frozen.manifest.files[relative].sha256) throw new Error(`Published V1 fingerprint changed: ${relative}`);
  }
  return { output, v1SourceCommit: V1_SOURCE_COMMIT, v1Files: frozen.files.length, v2Output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await buildPages()));
}
