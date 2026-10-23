import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

test('web build contains only public allowlist and refuses stale private files', async () => {
  const directory = await mkdtemp(new URL('./build-fixture-', import.meta.url));
  try {
    await mkdir(`${directory}/scripts`);
    await writeFile(`${directory}/scripts/build.mjs`, await readFile(new URL('../scripts/build.mjs', import.meta.url)));
    const run = () => spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: directory, encoding: 'utf8' });
    const missing = run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /Falta config.js/);
    for (const name of ['index.html', 'styles.css', 'app.js', 'README.md', 'setup.sql', 'tests.txt']) await writeFile(`${directory}/${name}`, name);
    await writeFile(`${directory}/config.js`, "// private note must not deploy\nexport const SUPABASE_URL = 'https://example.invalid';\nexport const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fake_fixture_abcdefghijklmnop';\n");
    const built = run(); assert.equal(built.status, 0, built.stderr);
    assert.deepEqual((await readdir(`${directory}/public`)).sort(), ['app.js', 'config.js', 'index.html', 'styles.css']);
    assert.doesNotMatch(await readFile(`${directory}/public/config.js`, 'utf8'), /private note/);
    await writeFile(`${directory}/public/private-notes.md`, 'must block publication');
    const stale = run(); assert.equal(stale.status, 1); assert.match(stale.stderr, /archivos ajenos/);
  } finally {
    // mkdtemp creates this verified child of tests/, never an externally supplied path.
    await rm(directory, { recursive: true, force: true });
  }
});

function legacyKey(role) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, iss: 'supabase', ref: 'synthetic-test' })}.${Buffer.alloc(32, 1).toString('base64url')}`;
}
const publicModern = 'sb_publishable_fake_fixture_abcdefghijklmnop';
const configText = (key, url = 'https://example.invalid/') => `export const SUPABASE_URL = '${url}';\nexport const SUPABASE_PUBLISHABLE_KEY = '${key}';\n`;
for (const [name, text, accepted] of [
  ['legacy anon JWT', configText(legacyKey('anon')), true],
  ['legacy service_role JWT', configText(legacyKey('service_role')), false],
  ['legacy authenticated JWT', configText(legacyKey('authenticated')), false],
  ['modern secret', configText('sb_secret_fake_fixture_abcdefghijklmnop'), false],
  ['short publishable', configText('sb_publishable_x'), false],
  ['non HTTPS URL', configText(publicModern, 'http://example.invalid'), false],
  ['URL whitespace', configText(publicModern, 'https://example.invalid '), false],
  ['URL escape', configText(publicModern, 'https://example.invalid\\u002f'), false],
  ['URL credentials', configText(publicModern, 'https://user:password@example.invalid'), false],
  ['URL query', configText(publicModern, 'https://example.invalid?x=1'), false],
  ['arbitrary executable config', `${configText(publicModern)}throw new Error('CONFIG_EXECUTED');`, false],
  ['additional exported values', `${configText(publicModern)}export const PRIVATE_VALUE = 'extra';`, false],
  ['duplicate public constant', `${configText(publicModern)}export const SUPABASE_URL = 'https://other.invalid';`, false],
  ['expression config', `export const SUPABASE_URL = new URL('https://example.invalid').origin;\nexport const SUPABASE_PUBLISHABLE_KEY = '${publicModern}';`, false]
]) {
  test(`build ${accepted ? 'accepts' : 'rejects before copying'} ${name}`, async () => {
    const directory = await mkdtemp(new URL('./build-fixture-', import.meta.url));
    try {
      await mkdir(`${directory}/scripts`);
      await writeFile(`${directory}/scripts/build.mjs`, await readFile(new URL('../scripts/build.mjs', import.meta.url)));
      for (const file of ['index.html', 'styles.css', 'app.js']) await writeFile(`${directory}/${file}`, file);
      await writeFile(`${directory}/config.js`, text);
      const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, accepted ? 0 : 1, result.stderr);
      if (accepted) {
        const deployed = await readFile(`${directory}/public/config.js`, 'utf8');
        assert.equal(deployed, `export const SUPABASE_URL = "https://example.invalid";\nexport const SUPABASE_PUBLISHABLE_KEY = "${legacyKey('anon')}";\n`);
      } else {
        assert.equal((await readdir(directory)).includes('public'), false, 'must reject before creating or copying deployment files');
        assert.doesNotMatch(result.stderr, /Error: CONFIG_EXECUTED/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
