import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPages, verifyFrozenV1, V1_SOURCE_COMMIT, V1_FILES } from '../scripts/build-pages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output;
before(async () => { output = await mkdtemp(join(tmpdir(), 'sx-pages-versions-')); });
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });

test('the V1 artifact is complete and fingerprinted against its original public source commit', async () => {
  const frozen = await verifyFrozenV1({ root });
  assert.equal(frozen.manifest.source_commit, '1a645827aa5c5b92b998a5373810bdfd3a4dbfbb');
  assert.equal(V1_SOURCE_COMMIT, frozen.manifest.source_commit);
  assert.deepEqual(frozen.files, [...V1_FILES].sort());
  const html = await readFile(join(frozen.site, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'none'/u);
  assert.doesNotMatch(html, /config\.js|app\.js|https?:\/\//u);
});

test('the Pages build keeps root V1 byte-for-byte and places the current app only under v2', async () => {
  const built = await buildPages({ root, output });
  assert.equal(built.v1SourceCommit, V1_SOURCE_COMMIT);
  assert.equal(built.v1Files, V1_FILES.length);
  for (const relative of V1_FILES) {
    assert.deepEqual(await readFile(join(output, relative)), await readFile(join(root, 'versions', 'v1', 'site', relative)), `V1 must remain identical: ${relative}`);
  }
  const v1 = await readFile(join(output, 'index.html'), 'utf8');
  const v2 = await readFile(join(output, 'v2', 'index.html'), 'utf8');
  assert.notEqual(v1, v2);
  assert.match(v2, /src="\.\/demo\.js"/u);
  assert.match(v2, /href="\.\/demo\.css"/u);
  assert.match(v2, /connect-src 'none'/u);
  assert.deepEqual(await readFile(join(output, 'v2', 'assets', 'v2', 'cofre-closed.png')), await readFile(join(root, 'assets', 'v2', 'cofre-closed.png')));
  const forum = await readFile(join(output, 'foro', 'index.html'), 'utf8');
  assert.match(forum, /connect-src 'self' https:\/\/oorheeyyahpyiarwktbq\.supabase\.co wss:\/\/oorheeyyahpyiarwktbq\.supabase\.co/u);
  assert.match(forum, /src="\.\/forum\.js\?v=notifications-20261026"/u);
  assert.match(forum, /worker-src 'self'/u);
  assert.match(forum, /href="\.\/manifest\.webmanifest"/u);
  assert.match(await readFile(join(output, 'foro', 'sw.js'), 'utf8'), /FC_SET_PUSH_BINDING/u);
  assert.match(v2, /href="\.\.\/foro\/"/u);
  const forumBundle = await readFile(join(output, 'foro', 'forum.js'), 'utf8');
  assert.match(forumBundle, /sb_publishable_/u);
  assert.doesNotMatch(forumBundle, /sb_secret_|SUPABASE_SERVICE_ROLE_KEY/u);
  // Rebuilding V2 must not transform or annotate the preserved root.
  await buildPages({ root, output });
  assert.deepEqual(await readFile(join(output, 'index.html')), await readFile(join(root, 'versions', 'v1', 'site', 'index.html')));
});

test('unknown root output is rejected before either version is changed', async t => {
  const contaminated = await mkdtemp(join(tmpdir(), 'sx-pages-root-'));
  t.after(() => rm(contaminated, { recursive: true, force: true }));
  await writeFile(join(contaminated, 'index.html'), 'preserve existing reviewed output');
  await writeFile(join(contaminated, 'config.js'), 'private fixture must never ship');
  await assert.rejects(buildPages({ root, output: contaminated }), /unexpected or linked file config\.js/u);
  assert.equal(await readFile(join(contaminated, 'index.html'), 'utf8'), 'preserve existing reviewed output');
});

test('unknown v2 output is also rejected before the preserved root is copied', async t => {
  const contaminated = await mkdtemp(join(tmpdir(), 'sx-pages-v2-'));
  t.after(() => rm(contaminated, { recursive: true, force: true }));
  await mkdir(join(contaminated, 'v2'), { recursive: true });
  await writeFile(join(contaminated, 'index.html'), 'existing root sentinel');
  await writeFile(join(contaminated, 'v2', 'config.js'), 'private fixture');
  await assert.rejects(buildPages({ root, output: contaminated }), /unexpected or linked file config\.js/u);
  assert.equal(await readFile(join(contaminated, 'index.html'), 'utf8'), 'existing root sentinel');
  const forumOutput = await mkdtemp(join(tmpdir(), 'sx-pages-forum-'));
  t.after(() => rm(forumOutput, { recursive: true, force: true }));
  await mkdir(join(forumOutput, 'foro'), { recursive: true });
  await writeFile(join(forumOutput, 'index.html'), 'forum root sentinel');
  await writeFile(join(forumOutput, 'foro', 'config.js'), 'private fixture');
  await assert.rejects(buildPages({ root, output: forumOutput }), /Unexpected forum file: config\.js/u);
  assert.equal(await readFile(join(forumOutput, 'index.html'), 'utf8'), 'forum root sentinel');
});

test('a changed V1 byte fails verification rather than silently redefining the preserved version', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'sx-v1-fingerprint-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const site = join(fixture, 'site');
  for (const relative of V1_FILES) {
    await mkdir(dirname(join(site, relative)), { recursive: true });
    await copyFile(join(root, 'versions', 'v1', 'site', relative), join(site, relative));
  }
  const manifestPath = join(fixture, 'manifest.json');
  await copyFile(join(root, 'versions', 'v1', 'manifest.json'), manifestPath);
  await writeFile(join(site, 'index.html'), 'unreviewed replacement of V1');
  await assert.rejects(verifyFrozenV1({ root, site, manifestPath }), /Frozen V1 fingerprint changed: index\.html/u);
});
