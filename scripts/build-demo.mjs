import { readFile, writeFile, mkdir, copyFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const DEMO_FILES = new Set(['index.html', 'demo.js', 'demo.css', '.nojekyll', 'assets/v11/portal-unicorn.png']);
const DEMO_DIRECTORIES = new Set(['assets', 'assets/v11']);

/** Review existing output before writing: never silently ship or remove extra files. */
export async function assertDemoOutput(output) {
  let existing;
  try { existing = await lstat(output); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Demo output must be an ordinary directory, not a file or symbolic link.');
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name), metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`Review demo output before building: symbolic link ${relative}`);
      if (metadata.isDirectory()) {
        if (!DEMO_DIRECTORIES.has(relative)) throw new Error(`Review demo output before building: unexpected directory ${relative}`);
        await inspect(absolute, relative);
      } else if (!metadata.isFile() || metadata.nlink > 1 || !DEMO_FILES.has(relative)) {
        throw new Error(`Review demo output before building: unexpected or linked file ${relative}`);
      }
    }
  }
  await inspect(output);
}

export function transformPlatformForDemo(source) {
  const changes = [
    ["if (['messages', 'community', 'cofre', 'care'].includes(destination) && !actor)", 'if (false)'],
    ["if (typeof document !== 'undefined') {", 'if (false) {'],
    ["image.src = '/assets/v11/portal-unicorn.png'", "image.src = './assets/v11/portal-unicorn.png'"]
  ];
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw new Error(`Review the demo adapter after changing the shared shell: ${before}`);
    source = source.replace(before, after);
  }
  return source.replaceAll('Entrar al ensayo', 'Sobre esta demo');
}

export async function buildDemo({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), output = join(root, 'dist'), dependencyRoot = process.env.SX_DEMO_DEPS_ROOT || root } = {}) {
  await assertDemoOutput(output);
  const require = createRequire(join(dependencyRoot, 'package.json'));
  const { build } = require('esbuild');
  await mkdir(join(output, 'assets', 'v11'), { recursive: true });
  await build({ entryPoints: [join(root, 'demo', 'demo.js')], outfile: join(output, 'demo.js'), bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, legalComments: 'inline',
    nodePaths: [join(dependencyRoot, 'node_modules')],
    plugins: [{ name: 'static-demo-shell-adapter', setup(builder) { builder.onLoad({ filter: /platform-v11\.js$/ }, async args => ({ contents: transformPlatformForDemo(await readFile(args.path, 'utf8')), loader: 'js' })); } }]
  });
  const cssNames = ['styles.css', 'cofre.css', 'forocromos.css', 'care.css', 'platform-v11.css', 'demo/demo.css'];
  const css = await Promise.all(cssNames.map(name => readFile(join(root, name), 'utf8')));
  await writeFile(join(output, 'demo.css'), css.join('\n'));
  await copyFile(join(root, 'demo', 'index.html'), join(output, 'index.html'));
  await copyFile(join(root, 'assets', 'v11', 'portal-unicorn.png'), join(output, 'assets', 'v11', 'portal-unicorn.png'));
  await writeFile(join(output, '.nojekyll'), '');
  return { output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildDemo(); console.log(`Static demo built: ${result.output}`);
}
