import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function validateVersion(tag) {
  const [pkg, manifest, lock] = await Promise.all(['package.json', 'manifest.json', 'package-lock.json'].map(async name => JSON.parse(await readFile(join(root, name), 'utf8'))));
  if (pkg.name !== 'pi-desktop-ocr' || lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name) throw new Error('Package names must all be pi-desktop-ocr.');
  if (manifest.id !== 'io.github.naza3.pi-desktop-ocr') throw new Error('Unexpected plugin identity.');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('The package version must be a semantic version.');
  if ([manifest.version, lock.version, lock.packages?.['']?.version].some(value => value !== pkg.version)) throw new Error('package.json, package-lock.json and manifest.json versions must match.');
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error(`Release tag must be v${pkg.version}; received ${tag}.`);
  return pkg.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== '--tag' || args.length !== 2)) throw new Error('Usage: node scripts/validate-version.mjs [--tag v0.1.0]');
  console.log(`Version validated: ${await validateVersion(args[1])}`);
}
