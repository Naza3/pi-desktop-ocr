import { build } from 'esbuild';
import { mkdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PI_REFERENCE } from './prepare-devkit.mjs';
import { validateVersion } from './validate-version.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build/plugin');
await validateVersion();
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'renderer'), { recursive: true });
await mkdir(join(out, 'licenses'), { recursive: true });
await build({ entryPoints: [join(root, 'src/main.ts')], outfile: join(out, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', legalComments: 'eof' });
await build({ entryPoints: [join(root, 'renderer/app.ts')], outfile: join(out, 'renderer/app.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', legalComments: 'eof' });
for (const file of ['manifest.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) await copyFile(join(root, file), join(out, file));
for (const file of ['index.html', 'style.css']) await copyFile(join(root, 'renderer', file), join(out, 'renderer', file));
for (const [pkg, file] of [['marked', 'LICENSE'], ['dompurify', 'LICENSE'], ['dompurify', 'LICENSE-MPL'], ['smol-toml', 'LICENSE']]) {
  await copyFile(join(root, 'node_modules', pkg, file), join(out, 'licenses', `${pkg}-${file}.txt`));
}
await copyFile(join(root, 'licenses/side-chat-MIT.txt'), join(out, 'licenses/side-chat-MIT.txt'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const revision = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
const commit = revision.status === 0 ? revision.stdout.trim() : null;
await writeFile(join(out, 'build-info.json'), JSON.stringify({ project: pkg.name, repository: 'https://github.com/Naza3/pi-desktop-ocr', pluginVersion: pkg.version, sourceCommit: commit, piDesktopReference: PI_REFERENCE, dependencies: pkg.dependencies }, null, 2) + '\n');
console.log('Plugin built: build/plugin');
