import { readFile, writeFile, mkdir, copyFile, readdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FORUM_FILES = Object.freeze(['index.html', 'forum.js', 'forum.css', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'assets/portal.webp', 'assets/cofre.webp', 'assets/portal-unicorn.png']);
export const FORUM_MIME = Object.freeze({ 'index.html': 'text/html; charset=utf-8', 'forum.js': 'text/javascript; charset=utf-8', 'forum.css': 'text/css; charset=utf-8', 'sw.js': 'text/javascript; charset=utf-8', 'manifest.webmanifest': 'application/manifest+json', 'icon.svg': 'image/svg+xml', 'assets/portal.webp': 'image/webp', 'assets/cofre.webp': 'image/webp', 'assets/portal-unicorn.png': 'image/png' });

export async function assertForumOutput(output) {
  let info; try { info = await lstat(output); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Forum output must be an ordinary directory.');
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = join(directory, entry.name), meta = await lstat(absolute);
      if (meta.isSymbolicLink()) throw new Error(`Unexpected forum symlink: ${relative}`);
      if (meta.isDirectory()) { if (relative !== 'assets') throw new Error(`Unexpected forum directory: ${relative}`); await inspect(absolute, relative); }
      else if (!meta.isFile() || meta.nlink > 1 || !FORUM_FILES.includes(relative)) throw new Error(`Unexpected forum file: ${relative}`);
    }
  }
  await inspect(output);
}

export async function buildForum({ root = rootDir, output = join(root, 'dist-pages', 'foro'), dependencyRoot = root } = {}) {
  await assertForumOutput(output); await mkdir(join(output, 'assets'), { recursive: true });
  const require = createRequire(join(dependencyRoot, 'package.json'));
  await require('esbuild').build({ entryPoints: [join(root, 'forum', 'forum.js')], outfile: join(output, 'forum.js'), bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, legalComments: 'inline', nodePaths: [join(dependencyRoot, 'node_modules')] });
  for (const file of ['index.html', 'forum.css', 'sw.js', 'manifest.webmanifest', 'icon.svg']) await copyFile(join(root, 'forum', file), join(output, file));
  for (const name of ['portal.webp', 'cofre.webp']) await copyFile(join(root, 'assets', 'v2', name), join(output, 'assets', name));
  await copyFile(join(root, 'assets', 'v11', 'portal-unicorn.png'), join(output, 'assets', 'portal-unicorn.png'));
  const bundle = await readFile(join(output, 'forum.js'), 'utf8');
  if (/sb_secret_|service_role|SUPABASE_SERVICE_ROLE_KEY/.test(bundle)) throw new Error('A server credential marker must never be shipped.');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex').slice(0,12),css=await readFile(join(output,'forum.css'));
  const html=(await readFile(join(output,'index.html'),'utf8')).replace(/\.\/forum\.js\?v=[^"\s]+/g,`./forum.js?v=forum-${hash(bundle)}`).replace(/\.\/forum\.css\?v=[^"\s]+/g,`./forum.css?v=forum-${hash(css)}`);
  await writeFile(join(output,'index.html'),html);
  return { output, files: FORUM_FILES.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await buildForum()));
