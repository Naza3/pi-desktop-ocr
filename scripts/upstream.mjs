import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDevkit } from './prepare-devkit.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
if (!['check', 'pack'].includes(command)) throw new Error('Expected check or pack');
const cli = await prepareDevkit();
await mkdir(join(root, 'dist'), { recursive: true });
const args = [cli, command, join(root, 'build/plugin'), ...(command === 'pack' ? ['--out', join(root, 'dist')] : [])];
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (command === 'pack') {
  const { createHash } = await import('node:crypto');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const name = `${manifest.id}-${manifest.version}.piplug`;
  const bytes = await readFile(join(root, 'dist', name));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(root, 'dist', `${name}.sha256`), `${hash}  ${name}\n`);
}
