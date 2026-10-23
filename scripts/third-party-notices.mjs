import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function writeThirdPartyNotices() {
  const root = new URL('../', import.meta.url);
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  const sections = ['SensualXcape local Cofre · third-party notices',
    'Pinned packages in package-lock.json. Includes development and platform packages; not all are shipped in browser bundles.'];
  let included = 0;
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location.startsWith('node_modules/') || location.split('/').includes('..')) continue;
    const directory = new URL(location + '/', root);
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (!names.length) continue; // Optional packages for other platforms are not installed.
    const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
    const notices = names.filter(name => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name));
    const texts = [];
    for (const name of notices) {
      try { texts.push(`${name}\n${await readFile(new URL(name, directory), 'utf8')}`); }
      catch (error) { if (error.code !== 'EISDIR') throw error; }
    }
    if (!texts.length) {
      const readme = names.find(name => /^readme(?:\.|$)/i.test(name));
      const content = readme ? await readFile(new URL(readme, directory), 'utf8') : '';
      const license = /(?:^|\n)#{1,3}\s*License\s*\r?\n([\s\S]*?)(?=\n#{1,3}\s|$)/i.exec(content);
      if (license) texts.push(`${readme} · License\n${license[1].trim()}`);
    }
    sections.push(`\n===== ${manifest.name}@${entry.version} (${manifest.license || entry.license || 'see package notices'}) =====\n${texts.join('\n\n') || 'No standalone notice found. Inspect the original package before redistribution.'}`);
    included++;
  }
  await writeFile(new URL('THIRD_PARTY_NOTICES.txt', root), sections.join('\n') + '\n');
  return { included };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await writeThirdPartyNotices()));
