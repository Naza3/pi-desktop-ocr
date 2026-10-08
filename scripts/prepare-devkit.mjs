import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_REFERENCE = '779e16d9c3ca2e966a7ae3db9dd0707243a2831f';
export const PI_REPOSITORY = 'https://github.com/vastsa/PI-Desktop.git';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}`);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** Build only PI's official SDK/devkit, without installing the desktop workspace. */
export async function prepareDevkit() {
  if (process.env.PI_PLUGIN_DEVKIT_CLI) {
    const cli = resolve(process.env.PI_PLUGIN_DEVKIT_CLI);
    if (!await exists(cli)) throw new Error('PI_PLUGIN_DEVKIT_CLI must point to an existing official plugin-devkit dist/cli.js.');
    console.log(`Using explicitly configured PI devkit: ${cli}`);
    return cli;
  }

  const typescript = JSON.parse(await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8'));
  const nodeTypes = JSON.parse(await readFile(join(root, 'node_modules/@types/node/package.json'), 'utf8'));
  if (typescript.version !== '5.9.3' || nodeTypes.version !== '24.10.1') {
    throw new Error('Run npm ci: the pinned devkit requires TypeScript 5.9.3 and @types/node 24.10.1.');
  }
  const cache = join(root, '.cache/pi-devkit');
  const source = join(cache, 'source');
  const cli = join(source, 'packages/plugin-devkit/dist/cli.js');
  const marker = JSON.stringify({ reference: PI_REFERENCE, typescript: typescript.version, nodeTypes: nodeTypes.version, recipe: 1 });
  if (await exists(cli) && await readFile(join(cache, 'prepared.json'), 'utf8').catch(() => '') === marker) return cli;

  await mkdir(cache, { recursive: true });
  // A failed preparation is rebuilt; this directory contains generated tools only.
  await rm(source, { recursive: true, force: true });
  run('git', ['init', '--quiet', source]);
  run('git', ['remote', 'add', 'origin', PI_REPOSITORY], source);
  run('git', ['config', 'core.sparseCheckout', 'true'], source);
  await mkdir(join(source, '.git/info'), { recursive: true });
  await writeFile(join(source, '.git/info/sparse-checkout'), '/*\n!/*/\n/packages/\n!/packages/*/\n/packages/plugin-sdk/\n/packages/plugin-devkit/\n');
  run('git', ['fetch', '--quiet', '--filter=blob:none', '--depth=1', 'origin', PI_REFERENCE], source);
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], source);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true });
  if (revision.status !== 0 || revision.stdout.trim() !== PI_REFERENCE) throw new Error('PI Desktop devkit reference verification failed.');

  await mkdir(join(source, 'node_modules/@pi-desktop'), { recursive: true });
  // Windows directory junctions do not need Developer Mode or symlink privileges.
  await symlink(join(source, 'packages/plugin-sdk'), join(source, 'node_modules/@pi-desktop/plugin-sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  for (const name of ['plugin-sdk', 'plugin-devkit']) {
    const dir = join(source, 'packages', name);
    await writeFile(join(dir, 'tsconfig.build.json'), JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { typeRoots: [join(root, 'node_modules/@types')] },
      exclude: ['src/**/*.test.ts'],
    }, null, 2) + '\n');
    run(process.execPath, [tsc, '-p', join(dir, 'tsconfig.build.json')]);
  }
  if (!await exists(cli)) throw new Error('The official PI devkit did not produce dist/cli.js.');
  await writeFile(join(cache, 'prepared.json'), marker);
  console.log(`Prepared official PI Desktop plugin-devkit at ${PI_REFERENCE}`);
  return cli;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareDevkit();
