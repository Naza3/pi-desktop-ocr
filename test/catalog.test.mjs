import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCatalog } from '../scripts/catalog.mjs';

const id = 'io.github.naza3.pi-desktop-ocr';
const repository = 'https://github.com/Naza3/pi-desktop-ocr';
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const publishedAt = '2026-10-08T20:00:00+08:00';

async function fixture(t, { version = '0.1.0', manifest: changes = {}, buildInfo: buildChanges = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-ocr-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginDir = join(root, 'plugin');
  const distDir = join(root, 'dist');
  await Promise.all([mkdir(pluginDir), mkdir(distDir)]);
  const manifest = {
    schemaVersion: 1, id, version, name: 'PI Desktop OCR', description: 'Local OCR', author: 'Naza3',
    permissions: ['ui.panel', 'fs.write', 'net.fetch'],
    engines: { piDesktop: '>=0.17.0' },
    fs: { write: { root: 'userSelected', scope: ['*.md'] } },
    net: { domains: ['127.0.0.1'] },
    ...changes,
  };
  const buildInfo = { project: 'pi-desktop-ocr', repository, pluginVersion: version, sourceCommit, ...buildChanges };
  const bytes = Buffer.from('Official pack/check output fixture\n');
  const fileName = `${id}-${version}.piplug`;
  const shasum = createHash('sha256').update(bytes).digest('hex');
  await Promise.all([
    writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(pluginDir, 'build-info.json'), JSON.stringify(buildInfo)),
    writeFile(join(pluginDir, 'README.md'), '# PI Desktop OCR\n'),
    writeFile(join(distDir, fileName), bytes),
    writeFile(join(distDir, `${fileName}.sha256`), `${shasum}  ${fileName}\n`),
  ]);
  return { pluginDir, distDir, sourceCommit, publishedAt, bytes, fileName, shasum };
}

test('catalog binds a real package hash, identity, declared access and source to an absolute Release URL', async t => {
  const input = await fixture(t);
  const catalog = await generateCatalog(input);
  assert.equal(catalog.schema_version, 2);
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.provider_id, 'custom');
  assert.equal(catalog.providerId, 'custom');
  const plugin = catalog.plugins[0];
  assert.equal(plugin.id, id);
  assert.equal(plugin.author, 'Naza3');
  assert.equal(plugin.verified, false);
  assert.equal(plugin.trust, 'unknown');
  assert.equal(plugin.readme_markdown, '# PI Desktop OCR\n');
  const version = plugin.versions[0];
  assert.equal(version.url, `${repository}/releases/download/v0.1.0/${id}-0.1.0.piplug`);
  assert.equal(version.shasum, input.shasum);
  assert.equal(version.sizeBytes, input.bytes.length);
  assert.equal(version.minPiDesktop, '0.17.0');
  assert.deepEqual(version.permissions, ['ui.panel', 'fs.write', 'net.fetch']);
  assert.deepEqual(version.fs, { write: { root: 'userSelected', scope: ['*.md'] } });
  assert.deepEqual(version.net, { domains: ['127.0.0.1'] });
  assert.deepEqual(version.provenance, { sourceRepository: repository, sourceRef: 'refs/tags/v0.1.0', sourceCommit, sourcePath: '.' });
  assert.equal(version.publishedAt, '2026-10-08T12:00:00.000Z');
  assert.deepEqual(JSON.parse(await readFile(join(input.distDir, 'catalog.json'), 'utf8')), catalog);
});

test('catalog bytes are stable across repeated builds and equivalent timestamp zones', async t => {
  const input = await fixture(t);
  await generateCatalog(input);
  const first = await readFile(join(input.distDir, 'catalog.json'));
  await generateCatalog({ ...input, tag: 'v0.1.0', publishedAt: '2026-10-08T12:00:00Z' });
  assert.deepEqual(await readFile(join(input.distDir, 'catalog.json')), first);
});

test('legal prerelease/build SemVer is preserved and URL path components are encoded', async t => {
  const version = '1.0.0-beta.2+build.7';
  const catalog = await generateCatalog(await fixture(t, { version }));
  const release = catalog.plugins[0].versions[0];
  assert.equal(release.version, version);
  assert.equal(release.url, `${repository}/releases/download/v1.0.0-beta.2%2Bbuild.7/${id}-1.0.0-beta.2%2Bbuild.7.piplug`);
  assert.equal(release.provenance.sourceRef, `refs/tags/v${version}`);
});

test('rejects tag/version mismatch and unsafe or malformed version paths before reading packages', async t => {
  const input = await fixture(t);
  for (const tag of ['v0.2.0', '../0.1.0', 'v0.1.0/next', '0.1.0', 'v0.1.0\n']) {
    await assert.rejects(generateCatalog({ ...input, tag }), /Release tag/);
  }
  for (const version of ['../outside', '01.0.0', '1.0.0-01', '1.0.0-beta..1', '1.0.0+', '1.0.0\n', 'v1.0.0']) {
    const manifestPath = join(input.pluginDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version }));
    await assert.rejects(generateCatalog(input), /semantic version/);
  }
});

test('rejects source, build provenance and plugin identity mismatches', async t => {
  for (const changes of [
    { manifest: { id: 'another.plugin' } },
    { buildInfo: { project: 'another-project' } },
    { buildInfo: { repository: 'https://github.com/another/project' } },
    { buildInfo: { pluginVersion: '0.2.0' } },
    { buildInfo: { sourceCommit: 'a'.repeat(40) } },
  ]) {
    await assert.rejects(generateCatalog(await fixture(t, changes)), /identity|build-info/);
  }
  const input = await fixture(t);
  for (const sourceCommit of ['49cb34a', 'z'.repeat(40), null]) {
    await assert.rejects(generateCatalog({ ...input, sourceCommit }), /full lowercase Git commit SHA/);
  }
});

test('rejects a changed package, wrong sidecar filename, or empty artifact', async t => {
  const input = await fixture(t);
  await writeFile(join(input.distDir, input.fileName), Buffer.from('changed bytes'));
  await assert.rejects(generateCatalog(input), /SHA256 sidecar/);
  await writeFile(join(input.distDir, input.fileName), input.bytes);
  await writeFile(join(input.distDir, `${input.fileName}.sha256`), `${input.shasum}  another.piplug\n`);
  await assert.rejects(generateCatalog(input), /SHA256 sidecar/);
  await writeFile(join(input.distDir, input.fileName), Buffer.alloc(0));
  await assert.rejects(generateCatalog(input), /must not be empty/);
});

test('rejects ambiguous author, unsupported host range and missing write scope', async t => {
  for (const [manifest, expected] of [
    [{ author: { name: 'Naza3' } }, /author must be a non-empty string/],
    [{ author: ' ' }, /author must be a non-empty string/],
    [{ engines: { piDesktop: '>=0.17.0 <1.0.0' } }, /single >=SemVer/],
    [{ engines: { piDesktop: '^0.17.0' } }, /single >=SemVer/],
    [{ engines: {} }, /single >=SemVer/],
    [{ permissions: ['fs.write', 'fs.write'] }, /unique/],
    [{ fs: {} }, /file scope/],
  ]) {
    await assert.rejects(generateCatalog(await fixture(t, { manifest })), expected);
  }
});

test('rejects timestamps without a timezone or a valid date', async t => {
  const input = await fixture(t);
  for (const publishedAt of ['2026-10-08', '2026-10-08T12:00:00', 'invalid', '2026-13-08T12:00:00Z']) {
    await assert.rejects(generateCatalog({ ...input, publishedAt }), /ISO 8601 timestamp/);
  }
});
