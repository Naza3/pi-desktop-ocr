import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { validateVersion } from './validate-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'Naza3/pi-desktop-ocr';
const repositoryUrl = `https://github.com/${repository}`;
const pluginId = 'io.github.naza3.pi-desktop-ocr';
const execute = promisify(execFile);

function parseVersion(version) {
  if (typeof version !== 'string' || version.length > 128) throw new Error('Invalid release semantic version.');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) throw new Error('Invalid release semantic version.');
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(value => /^\d+$/.test(value) && value.length > 1 && value.startsWith('0'))) throw new Error('Invalid release semantic version.');
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    const numericA = /^\d+$/.test(a.pre[i]); const numericB = /^\d+$/.test(b.pre[i]);
    if (numericA && numericB) return BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}

export async function validateReleaseAssets({ distDir, tag, expectedCommit, manifest }) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const version = tag.slice(1);
  const parsed = parseVersion(version);
  if (manifest?.id !== pluginId || manifest.version !== version) throw new Error('Release manifest identity or version does not match the tag.');
  if (typeof expectedCommit !== 'string' || !/^[a-f0-9]{40}$/.test(expectedCommit)) throw new Error('Expected source commit must be a full Git commit SHA.');
  const packageName = `${pluginId}-${version}.piplug`;
  const names = [packageName, `${packageName}.sha256`, 'catalog.json'];
  if (!isDeepStrictEqual((await readdir(distDir)).sort(), [...names].sort())) throw new Error('Release dist must contain exactly the package, its SHA256 sidecar and catalog.json.');
  const contents = new Map(await Promise.all(names.map(async name => [name, await readFile(join(distDir, name))])));
  const bytes = contents.get(packageName);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!bytes.length || contents.get(`${packageName}.sha256`).toString('utf8').trimEnd() !== `${hash}  ${packageName}`) throw new Error('Package SHA256 sidecar does not match its bytes and filename.');
  const catalog = JSON.parse(contents.get('catalog.json').toString('utf8'));
  if (catalog?.schema_version !== 2 || (catalog.schemaVersion !== undefined && catalog.schemaVersion !== 2) || catalog.provider_id !== 'custom' || (catalog.providerId !== undefined && catalog.providerId !== 'custom')) throw new Error('Catalog must declare schema 2 and the custom provider.');
  if (!Array.isArray(catalog.plugins) || catalog.plugins.length !== 1 || catalog.plugins[0]?.id !== pluginId) throw new Error('Unexpected catalog plugin identity.');
  const versions = catalog.plugins[0].versions;
  if (!Array.isArray(versions) || versions.length !== 1) throw new Error('Catalog must describe exactly this release version.');
  const entry = versions[0];
  const expectedUrl = `${repositoryUrl}/releases/download/${tag}/${packageName}`;
  const minimum = manifest.engines?.piDesktop;
  if (typeof minimum !== 'string' || !minimum.startsWith('>=')) throw new Error('Manifest must declare a single minimum PI Desktop version.');
  parseVersion(minimum.slice(2));
  if (entry?.version !== version || entry.url !== expectedUrl || entry.shasum !== hash || entry.sizeBytes !== bytes.length || entry.provenance?.sourceCommit !== expectedCommit || entry.provenance.sourceRepository !== repositoryUrl || entry.provenance.sourceRef !== `refs/tags/${tag}` || entry.minPiDesktop !== minimum.slice(2) || entry.yanked === true) throw new Error('Catalog version, URL, SHA256, size, source commit or host requirement does not match the release.');
  if (!isDeepStrictEqual(entry.permissions, manifest.permissions) || !isDeepStrictEqual(entry.fs, manifest.fs) || !isDeepStrictEqual(entry.net, manifest.net)) throw new Error('Catalog permissions differ from the committed manifest.');
  if (typeof entry.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(entry.publishedAt) || !Number.isFinite(Date.parse(entry.publishedAt))) throw new Error('Catalog publishedAt must be an ISO timestamp in UTC.');
  return { version, prerelease: parsed.pre.length > 0, names, contents };
}

// Keep the command boundary injectable: tests never contact GitHub or require a token.
async function githubCommand(args) {
  try {
    const result = await execute('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function api(gh, path) {
  const result = await gh(['api', '--include', `repos/${repository}/${path}`]);
  // gh returns nonzero for both HTTP errors and transport failures. Only an
  // actual HTTP 404 means absent; never interpret denied access as absence.
  const matches = [...result.stdout.matchAll(/^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/gm)];
  const header = matches.at(-1);
  if (!header) throw new Error('GitHub API request failed without an HTTP response.');
  const status = Number(header[1]);
  if (status === 404) return null;
  if (result.code !== 0 || status !== 200) throw new Error(`GitHub API request failed (HTTP ${status}).`);
  const response = result.stdout.slice(header.index + header[0].length);
  const separator = /\r?\n\r?\n/.exec(response);
  // With no response headers, the blank line is the first character.
  const body = response.startsWith('\r\n') ? response.slice(2) : response.startsWith('\n') ? response.slice(1) : separator ? response.slice(separator.index + separator[0].length) : '';
  try { return JSON.parse(body); } catch { throw new Error('GitHub API returned invalid JSON.'); }
}

async function command(gh, args) {
  const result = await gh(args);
  if (result.code !== 0) throw new Error(`GitHub command failed: gh ${args.slice(0, 2).join(' ')} (exit ${result.code}).`);
}

async function findRelease(gh, tag) {
  const published = await api(gh, `releases/tags/${encodeURIComponent(tag)}`);
  if (published !== null) return published;
  // REST's by-tag endpoint only finds published releases. The authenticated
  // releases collection also includes drafts; inspect all pages before create.
  for (let page = 1; ; page++) {
    const releases = await api(gh, `releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Cannot enumerate GitHub releases to locate an existing draft.');
    const found = releases.find(release => release.tag_name === tag);
    if (found) return found;
    if (releases.length < 100) return null;
  }
}

function validateRemoteRelease(release, tag, names, checkAssets = true) {
  if (!release || release.tag_name !== tag || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('GitHub returned unexpected release metadata.');
  if (checkAssets && (!Array.isArray(release.assets) || !isDeepStrictEqual(release.assets.map(asset => asset.name).sort(), [...names].sort()))) throw new Error('Remote release must contain exactly the three expected assets.');
}

async function verifyDownloads(gh, tag, assets) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-ocr-release-'));
  try {
    await command(gh, ['release', 'download', tag, '--repo', repository, '--dir', directory, ...assets.names.flatMap(name => ['--pattern', name])]);
    for (const name of assets.names) {
      const downloaded = await readFile(join(directory, name));
      if (!downloaded.equals(assets.contents.get(name))) throw new Error(`Downloaded release asset differs from the validated build: ${name}.`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function publishRelease({ tag, expectedCommit, manifest, distDir = join(root, 'dist'), gh = githubCommand }) {
  const assets = await validateReleaseAssets({ distDir, tag, expectedCommit, manifest });
  let release = await findRelease(gh, tag);
  if (release !== null) {
    validateRemoteRelease(release, tag, assets.names, !release.draft);
    if (!release.draft) {
      if (release.prerelease !== assets.prerelease) throw new Error('Published release prerelease status differs from its version.');
      await verifyDownloads(gh, tag, assets);
      return { tag, published: false, alreadyPublished: true };
    }
    if (!Array.isArray(release.assets) || release.assets.some(asset => !assets.names.includes(asset.name))) throw new Error('Existing draft has unexpected assets; review it before retrying.');
  } else {
    await command(gh, ['release', 'create', tag, '--repo', repository, '--draft', '--verify-tag', '--generate-notes', '--latest=false', ...(assets.prerelease ? ['--prerelease'] : [])]);
  }
  await command(gh, ['release', 'upload', tag, ...assets.names.map(name => join(distDir, name)), '--repo', repository, '--clobber']);
  release = await findRelease(gh, tag);
  validateRemoteRelease(release, tag, assets.names);
  if (!release.draft) throw new Error('Release became public before upload verification; refusing to edit it.');
  await verifyDownloads(gh, tag, assets);
  let latest = false;
  if (!assets.prerelease) {
    const current = await api(gh, 'releases/latest');
    if (current !== null && (current.draft !== false || current.prerelease !== false || typeof current.tag_name !== 'string' || !current.tag_name.startsWith('v'))) throw new Error('Current latest release does not have a supported stable version.');
    if (current !== null && parseVersion(current.tag_name.slice(1)).pre.length) throw new Error('Current latest release has a prerelease version.');
    latest = current === null || compareVersions(assets.version, current.tag_name.slice(1)) > 0;
  }
  await command(gh, ['release', 'edit', tag, '--repo', repository, '--draft=false', `--prerelease=${assets.prerelease}`, `--latest=${latest}`]);
  const published = await findRelease(gh, tag);
  validateRemoteRelease(published, tag, assets.names);
  if (published.draft || published.prerelease !== assets.prerelease) throw new Error('Release publication could not be confirmed.');
  return { tag, published: true, alreadyPublished: false, latest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--tag') throw new Error('Usage: node scripts/publish-release.mjs --tag v0.1.0');
  await validateVersion(args[1]);
  const expectedCommit = (await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();
  const tagCommit = (await execute('git', ['rev-parse', '--verify', `refs/tags/${args[1]}^{commit}`], { cwd: root, encoding: 'utf8' })).stdout.trim();
  if (tagCommit !== expectedCommit || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== expectedCommit)) throw new Error('Checked-out HEAD, tag and GITHUB_SHA must identify the same commit.');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const result = await publishRelease({ tag: args[1], expectedCommit, manifest });
  console.log(result.alreadyPublished ? `Verified unchanged published Release ${result.tag}.` : `Published verified Release ${result.tag}; latest=${result.latest}.`);
}
