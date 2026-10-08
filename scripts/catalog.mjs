import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVersion } from './validate-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginId = 'io.github.naza3.pi-desktop-ocr';
const repository = 'https://github.com/Naza3/pi-desktop-ocr';
// SemVer 2.0: numeric core/prerelease identifiers cannot have leading zeroes.
const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function gitValue(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Cannot read the source commit from Git.');
  return result.stdout.trim();
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function minimumHostVersion(engines) {
  // host-core parses minPiDesktop as a Version, not a VersionReq. Passing
  // ">=0.17.0" would fail open; refuse ranges we cannot express faithfully.
  const range = object(engines) ? engines.piDesktop : undefined;
  if (typeof range !== 'string' || !range.startsWith('>=') || !semver.test(range.slice(2))) {
    throw new Error('engines.piDesktop must be a single >=SemVer minimum, without a complex range.');
  }
  return range.slice(2);
}

function validatePermissions(manifest) {
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || !permissions.length || permissions.some(value => typeof value !== 'string' || !value.trim()) || new Set(permissions).size !== permissions.length) {
    throw new Error('manifest.permissions must contain unique, non-empty permission strings.');
  }
  if (manifest.fs !== undefined && !object(manifest.fs)) throw new Error('manifest.fs must be an object.');
  for (const mode of ['write', 'delete']) {
    if (!permissions.includes(`fs.${mode}`)) continue;
    const rule = manifest.fs?.[mode];
    if (!object(rule) || !(rule.root === 'userSelected' || (Array.isArray(rule.scope) && rule.scope.length > 0 && rule.scope.every(value => typeof value === 'string' && value.trim())) || (mode === 'delete' && rule.own === true))) {
      throw new Error(`manifest.fs.${mode} must declare its file scope.`);
    }
  }
  return permissions;
}

/**
 * Describe the artifact produced by the same successful pack/check run.
 * ZIP/manifest validation belongs to the pinned official pack/check tooling;
 * this step binds its metadata, source revision and checksum to a Release URL.
 * Explicit source/time arguments make isolated fixtures reproducible.
 */
export async function generateCatalog({
  pluginDir = join(root, 'build/plugin'),
  distDir = join(root, 'dist'),
  tag,
  sourceCommit = gitValue(['rev-parse', '--verify', 'HEAD']),
  publishedAt = gitValue(['show', '-s', '--format=%cI', 'HEAD']),
} = {}) {
  const [manifest, buildInfo, readme] = await Promise.all([
    readFile(join(pluginDir, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(pluginDir, 'build-info.json'), 'utf8').then(JSON.parse),
    readFile(join(pluginDir, 'README.md'), 'utf8'),
  ]);
  if (!object(manifest) || manifest.id !== pluginId) throw new Error('Unexpected plugin identity in the packaged manifest.');
  if (typeof manifest.version !== 'string' || !semver.test(manifest.version)) throw new Error('The packaged version must be a valid semantic version.');
  const releaseTag = tag ?? `v${manifest.version}`;
  if (releaseTag !== `v${manifest.version}`) throw new Error(`Release tag must be v${manifest.version}.`);
  if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('sourceCommit must be a full lowercase Git commit SHA.');
  if (!object(buildInfo) || buildInfo.project !== 'pi-desktop-ocr' || buildInfo.repository !== repository || buildInfo.pluginVersion !== manifest.version || buildInfo.sourceCommit !== sourceCommit) {
    throw new Error('Packaged build-info identity, version or source commit does not match this release.');
  }
  if (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) {
    throw new Error('publishedAt must be an ISO 8601 timestamp with a timezone.');
  }
  // Use the source commit timestamp instead of wall time: Linux/Windows builds
  // of the same revision must generate exactly the same catalog bytes.
  const timestamp = new Date(publishedAt).toISOString();
  const name = nonEmptyString(manifest.name, 'manifest.name');
  const description = nonEmptyString(manifest.description, 'manifest.description');
  const author = nonEmptyString(manifest.author, 'manifest.author');
  const permissions = validatePermissions(manifest);
  const minPiDesktop = minimumHostVersion(manifest.engines);
  const fileName = `${pluginId}-${manifest.version}.piplug`;
  const [bytes, sidecar] = await Promise.all([
    readFile(join(distDir, fileName)),
    readFile(join(distDir, `${fileName}.sha256`), 'utf8'),
  ]);
  if (!bytes.length) throw new Error('The plugin package must not be empty.');
  const shasum = createHash('sha256').update(bytes).digest('hex');
  if (sidecar.trimEnd() !== `${shasum}  ${fileName}`) throw new Error('Package SHA256 sidecar does not match its bytes and filename.');
  const artifactBase = `${repository}/releases/download/${encodeURIComponent(releaseTag)}/`;
  const catalog = {
    // host-core serde uses snake_case here; the official JavaScript preflight
    // reads schemaVersion. Keep both declarations identical until upstream
    // unifies the schema. Version/provenance fields already use camelCase.
    schema_version: 2,
    schemaVersion: 2,
    provider_id: 'custom',
    providerId: 'custom',
    catalog_id: pluginId,
    name: 'PI Desktop OCR 自定义插件源',
    homepage: repository,
    updated_at: timestamp,
    generated_at: timestamp,
    artifact_base_url: artifactBase,
    plugins: [{
      id: pluginId,
      name,
      description,
      author,
      categories: ['productivity'],
      verified: false,
      trust: 'unknown',
      homepage: repository,
      repository,
      readme_markdown: readme,
      versions: [{
        version: manifest.version,
        publishedAt: timestamp,
        minPiDesktop,
        shasum,
        url: `${artifactBase}${encodeURIComponent(fileName)}`,
        sizeBytes: bytes.length,
        permissions,
        ...(manifest.fs === undefined ? {} : { fs: manifest.fs }),
        ...(manifest.net === undefined ? {} : { net: manifest.net }),
        yanked: false,
        provenance: {
          sourceRepository: repository,
          sourceRef: `refs/tags/${releaseTag}`,
          sourceCommit,
          sourcePath: '.',
        },
      }],
    }],
  };
  await writeFile(join(distDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== '--tag' || args.length !== 2)) throw new Error('Usage: node scripts/catalog.mjs [--tag v0.1.0]');
  const version = await validateVersion(args[1]);
  const catalog = await generateCatalog({ tag: args[1] ?? `v${version}` });
  if (catalog.plugins[0].versions[0].version !== version) throw new Error('Packaged version differs from the source version; rebuild before generating the catalog.');
  console.log(`Generated dist/catalog.json for ${pluginId}@${version}; this command does not publish a Release.`);
}
