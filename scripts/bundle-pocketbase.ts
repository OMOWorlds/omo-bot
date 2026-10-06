import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { bundleFiles as files } from '../apps/setup/src/sftp.js';
const hashes: Record<string, string> = {};
for (const file of files) {
  await mkdir(`dist/pockethost/${file.split('/')[0]}`, { recursive: true });
  await copyFile(`infra/pocketbase/${file}`, `dist/pockethost/${file}`);
  hashes[file] = createHash('sha256').update(await readFile(`infra/pocketbase/${file}`)).digest('hex');
}
await writeFile('dist/pockethost/manifest.json', JSON.stringify({ protocol: 1, trafficProtocol: 1, secretsProtocol: 1, messageCacheProtocol: 1, testedPocketBase: '0.40.4', files: hashes }, null, 2));
for (const file of ['LICENSE', 'NOTICE']) await copyFile(file, `dist/pockethost/${file}`);
console.info('PocketHost upload bundle prepared in dist/pockethost (hooks and migrations only; no secrets or data).');
