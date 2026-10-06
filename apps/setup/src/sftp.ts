import SftpClient from 'ssh2-sftp-client';
import type { Client } from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { SetupError, type SftpInput } from './model.js';
export const bundleFiles = ['pb_migrations/1790265600_omo_storage.js', 'pb_migrations/1790265601_instance_binding.js', 'pb_migrations/1790265602_module_resources.js', 'pb_migrations/1790851200_module_secrets.js', 'pb_hooks/000_omo_headless.pb.js', 'pb_hooks/operations.js', 'pb_hooks/message-cache.js', 'pb_hooks/installation.js', 'pb_hooks/omo.pb.js'];
const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
// v12 exposes its transport; DefinitelyTyped v9 has not added this public property yet.
const client = () => new SftpClient('omo-installer', { error: () => {}, end: () => {}, close: () => {} }) as SftpClient & { client: Client };
export async function probeSftp(host: string, port: number) {
  const sftp = client(); let found = '';
  try { await sftp.connect({ host, port, username: 'fingerprint-probe', readyTimeout: 10000, hostVerifier: (key: Buffer) => { found = fingerprint(key); return false; } }); }
  catch { if (!found) throw new SetupError('Cannot reach the SFTP server. Check its address and port.'); }
  finally { await sftp.end().catch(() => {}); }
  return found;
}
export async function uploadBundle(input: SftpInput, progress: (message: string) => void) {
  const sftp = client();
  // Kill the underlying connection on deadline; do not leave a timed-out upload running.
  const deadline = setTimeout(() => sftp.client.destroy(), 60000);
  try {
    await sftp.connect({ host: input.host, port: input.port, username: input.username, privateKey: input.privateKey, passphrase: input.passphrase, readyTimeout: 10000, hostVerifier: (key: Buffer) => fingerprint(key) === input.fingerprint });
    const root = await sftp.realPath(input.directory);
    const files = await Promise.all(bundleFiles.map(async file => ({ file, bytes: await readFile(`infra/pocketbase/${file}`) })));
    // Check the entire bundle before writing anything. This initial installer never overwrites a differing file.
    for (const { file, bytes } of files) {
      const path = posix.join(root, file), parent = posix.dirname(path);
      if (await sftp.exists(parent)) { if (await sftp.realPath(parent) !== parent) throw new SetupError('Deployment folders must not be symbolic links.'); }
      if (await sftp.exists(path)) {
        const info = await sftp.stat(path);
        if (await sftp.exists(path) !== '-' || !info.isFile || info.size > 1048576) throw new SetupError('A deployment path is not a regular bundle file.');
        const current = await sftp.get(path);
        if (!Buffer.isBuffer(current) || !current.equals(bytes)) throw new SetupError(`Existing ${file} differs from this bundle. Use a fresh instance or the documented upgrade procedure.`);
      }
    }
    for (const { file, bytes } of files) {
      const path = posix.join(root, file); if (await sftp.exists(path)) continue;
      await sftp.mkdir(posix.dirname(path), true);
      const temporary = `${path}.${randomUUID()}.upload`;
      try { await sftp.put(bytes, temporary); await sftp.chmod(temporary, 0o600); await sftp.rename(temporary, path); }
      finally { await sftp.delete(temporary, true).catch(() => {}); }
      progress(`Uploaded ${file.split('/').pop()}.`);
    }
  } catch (error) { if (error instanceof SetupError) throw error; throw new SetupError('SFTP upload failed. Check the confirmed fingerprint, instance folder and deployment key.'); }
  finally { clearTimeout(deadline); await sftp.end().catch(() => {}); }
}
