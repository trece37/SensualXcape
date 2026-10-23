import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeThirdPartyNotices } from './third-party-notices.mjs';

// Local-only artifact: never copied by the separate public deployment allowlist.
export async function buildCofre() {
  // Storage guards resolve this reserved web root even in a fresh checkout.
  // Keep it empty here: local QA generates its configuration in memory.
  await mkdir(new URL('../public/', import.meta.url), { recursive: true });
  await writeThirdPartyNotices();
  const output = new URL('../local-assets/', import.meta.url);
  await mkdir(output, { recursive: true });
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../cofre.js', import.meta.url))],
    outfile: fileURLToPath(new URL('cofre-bundle.js', output)),
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
    minify: true, sourcemap: false, legalComments: 'eof', metafile: true,
  });
  const client = await build({
    stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
    outfile: fileURLToPath(new URL('supabase-client.js', output)),
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
    minify: true, sourcemap: false, legalComments: 'eof', metafile: true,
  });
  const community = await build({
    entryPoints: [fileURLToPath(new URL('../forocromos.js', import.meta.url))],
    outfile: fileURLToPath(new URL('forocromos-bundle.js', output)),
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
    minify: true, sourcemap: false, legalComments: 'eof', metafile: true,
  });
  const platform = await build({
    entryPoints: {
      'care-bundle': fileURLToPath(new URL('../care.js', import.meta.url)),
      'platform-v11-bundle': fileURLToPath(new URL('../platform-v11.js', import.meta.url))
    },
    outdir: fileURLToPath(output), bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
    minify: true, sourcemap: false, legalComments: 'eof', metafile: true,
  });
  return { outputs: [result, client, community, platform].flatMap(item => Object.values(item.metafile.outputs)).map(item => ({ bytes: item.bytes })) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await buildCofre()));
}
