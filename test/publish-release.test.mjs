import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { compareVersions, publishRelease, validateReleaseAssets } from '../scripts/publish-release.mjs';

const id = 'io.github.naza3.pi-desktop-ocr';
const commit = 'a'.repeat(40);
const repo = 'Naza3/pi-desktop-ocr';
const http = (status, value) => ({ code: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} Test\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}`, stderr: status === 200 ? '' : `gh: HTTP ${status}` });

async function fixture(t, version = '0.1.0') {
  const distDir = await mkdtemp(join(tmpdir(), 'pi-ocr-publish-test-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  const tag = `v${version}`;
  const manifest = { id, version, permissions: ['ui.view', 'fs.write'], engines: { piDesktop: '>=0.17.0' }, fs: { write: { root: 'userSelected', scope: ['*.md'] } }, net: { domains: ['127.0.0.1'] } };
  const name = `${id}-${version}.piplug`;
  const bytes = Buffer.from('fixture package bytes, never installed or executed');
  const shasum = createHash('sha256').update(bytes).digest('hex');
  const catalog = { schema_version: 2, schemaVersion: 2, provider_id: 'custom', providerId: 'custom', plugins: [{ id, versions: [{ version, publishedAt: '2026-10-08T08:00:00.000Z', url: `https://github.com/${repo}/releases/download/${tag}/${name}`, shasum, sizeBytes: bytes.length, permissions: manifest.permissions, fs: manifest.fs, net: manifest.net, minPiDesktop: '0.17.0', provenance: { sourceCommit: commit, sourceRef: `refs/tags/${tag}`, sourceRepository: `https://github.com/${repo}` } }] }] };
  await Promise.all([
    writeFile(join(distDir, name), bytes),
    writeFile(join(distDir, `${name}.sha256`), `${shasum}  ${name}\n`),
    writeFile(join(distDir, 'catalog.json'), JSON.stringify(catalog)),
  ]);
  return { distDir, tag, expectedCommit: commit, manifest, name, catalog };
}

async function fakeGithub(f, options = {}) {
  const calls = [];
  const names = [f.name, `${f.name}.sha256`, 'catalog.json'];
  const stored = new Map();
  if (options.existing) for (const name of names) stored.set(name, await readFile(join(f.distDir, name)));
  let release = options.existing ? { tag_name: f.tag, draft: options.existing === 'draft', prerelease: f.manifest.version.includes('-') } : null;
  const metadata = () => release ? { ...release, assets: [...stored.keys()].map(name => ({ name })) } : null;
  if (options.corruptExisting) stored.set('catalog.json', Buffer.from('previously published different bytes'));
  if (options.unexpectedAsset) stored.set('unexpected.txt', Buffer.from('unvalidated'));
  const gh = async args => {
    calls.push(args);
    if (args[0] === 'api') {
      const endpoint = args[2];
      if (options.apiFailure && (!options.failLatestOnly || endpoint.endsWith('/latest'))) return options.apiFailure;
      if (endpoint === `repos/${repo}/releases/latest`) return options.latest ? http(200, { tag_name: options.latest, draft: false, prerelease: false }) : http(404, { message: 'Not Found' });
      if (endpoint.startsWith(`repos/${repo}/releases?`)) {
        if (options.listFailure) return options.listFailure;
        if (options.paginated && endpoint.endsWith('page=1')) return http(200, Array.from({ length: 100 }, (_, i) => ({ tag_name: `v9.0.${i}`, draft: false, prerelease: false, assets: [] })));
        return http(200, release ? [metadata()] : []);
      }
      assert.equal(endpoint, `repos/${repo}/releases/tags/${f.tag}`);
      return release && !release.draft ? http(200, metadata()) : http(404, { message: 'Not Found' });
    }
    assert.equal(args[0], 'release');
    assert.equal(args[2], f.tag);
    assert.equal(args[args.indexOf('--repo') + 1], repo);
    if (args[1] === 'create') {
      assert.equal(release, null);
      assert(args.includes('--draft'));
      assert(args.includes('--verify-tag'));
      assert(args.includes('--generate-notes'));
      release = { tag_name: f.tag, draft: true, prerelease: args.includes('--prerelease') };
    } else if (args[1] === 'upload') {
      assert(release?.draft, 'must never overwrite published assets');
      assert(args.includes('--clobber'));
      const paths = args.slice(3, args.indexOf('--repo'));
      assert.deepEqual(paths.map(path => basename(path)).sort(), [...names].sort());
      for (const path of paths) stored.set(basename(path), await readFile(path));
    } else if (args[1] === 'download') {
      assert.deepEqual(args.flatMap((value, i) => value === '--pattern' ? [args[i + 1]] : []).sort(), [...names].sort());
      const destination = args[args.indexOf('--dir') + 1];
      for (const [name, bytes] of stored) await writeFile(join(destination, name), options.corruptDownload && name === f.name ? Buffer.from('corrupt download') : bytes);
    } else if (args[1] === 'edit') {
      assert(args.includes('--draft=false'));
      release.draft = false;
      release.prerelease = args.includes('--prerelease=true');
    } else {
      assert.fail(`Unexpected gh subcommand ${args[1]}`);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { gh, calls, stored, metadata, mutations: () => calls.filter(args => ['create', 'upload', 'edit'].includes(args[1])) };
}

test('新版本先建 draft、上传精确三附件，下载逐字节验证后才发布为 latest', async t => {
  const f = await fixture(t, '0.2.0');
  const remote = await fakeGithub(f, { latest: 'v0.1.0' });
  const result = await publishRelease({ ...f, gh: remote.gh });
  assert.deepEqual(result, { tag: f.tag, published: true, alreadyPublished: false, latest: true });
  assert.deepEqual(remote.calls.filter(args => args[0] === 'release').map(args => args[1]), ['create', 'upload', 'download', 'edit']);
  assert(remote.calls.find(args => args[1] === 'edit').includes('--latest=true'));
  assert.equal(remote.metadata().draft, false);
});

test('没有已发布版本时首个稳定版本成为 latest', async t => {
  const f = await fixture(t);
  const remote = await fakeGithub(f);
  assert.equal((await publishRelease({ ...f, gh: remote.gh })).latest, true);
});

test('补发旧稳定 tag 不让 latest 自定义源回退', async t => {
  const f = await fixture(t, '0.1.0');
  const remote = await fakeGithub(f, { latest: 'v0.2.0' });
  assert.equal((await publishRelease({ ...f, gh: remote.gh })).latest, false);
  assert(remote.calls.find(args => args[1] === 'edit').includes('--latest=false'));
});

test('预发布永不成为 stable latest，也不查询稳定版本', async t => {
  const f = await fixture(t, '1.0.0-rc.1');
  const remote = await fakeGithub(f);
  const result = await publishRelease({ ...f, gh: remote.gh });
  assert.equal(result.latest, false);
  const edit = remote.calls.find(args => args[1] === 'edit');
  assert(edit.includes('--prerelease=true')); assert(edit.includes('--latest=false'));
  assert(remote.calls.find(args => args[1] === 'create').includes('--prerelease'));
  assert(!remote.calls.some(args => args[2]?.endsWith('/latest')));
});

test('中断后的 draft 可以重试覆盖附件并重新验证', async t => {
  const f = await fixture(t);
  const remote = await fakeGithub(f, { existing: 'draft', corruptExisting: true });
  await publishRelease({ ...f, gh: remote.gh });
  assert(!remote.calls.some(args => args[1] === 'create'));
  assert.deepEqual(remote.mutations().map(args => args[1]), ['upload', 'edit']);
  assert.deepEqual(remote.stored.get('catalog.json'), await readFile(join(f.distDir, 'catalog.json')));
});

test('draft 不能从 by-tag 获取时从分页列表寻找，避免重复创建', async t => {
  const f = await fixture(t);
  const remote = await fakeGithub(f, { existing: 'draft', paginated: true });
  await publishRelease({ ...f, gh: remote.gh });
  assert(remote.calls.some(args => args[2] === `repos/${repo}/releases?per_page=100&page=2`));
  assert(!remote.calls.some(args => args[1] === 'create'));
});

test('不能列出草稿时不会误判为缺失并创建另一个 Release', async t => {
  const f = await fixture(t);
  for (const status of [403, 404]) {
    const remote = await fakeGithub(f, { listFailure: http(status, {}) });
    await assert.rejects(publishRelease({ ...f, gh: remote.gh }), /HTTP 403|Cannot enumerate/);
    assert.equal(remote.mutations().length, 0);
  }
});

test('已公开且附件完全相同的 Release 幂等成功，绝不覆盖或改 latest', async t => {
  const f = await fixture(t);
  const remote = await fakeGithub(f, { existing: 'public' });
  const result = await publishRelease({ ...f, gh: remote.gh });
  assert.deepEqual(result, { tag: f.tag, published: false, alreadyPublished: true });
  assert.equal(remote.mutations().length, 0);
  assert(remote.calls.some(args => args[1] === 'download'));
});

test('已公开 Release 字节不同则报错，不覆盖已有附件', async t => {
  const f = await fixture(t);
  const remote = await fakeGithub(f, { existing: 'public', corruptExisting: true });
  await assert.rejects(publishRelease({ ...f, gh: remote.gh }), /Downloaded release asset differs/);
  assert.equal(remote.mutations().length, 0);
});

test('损坏下载验证失败时保留 draft，不发布残缺 Release', async t => {
  const f = await fixture(t);
  const remote = await fakeGithub(f, { corruptDownload: true });
  await assert.rejects(publishRelease({ ...f, gh: remote.gh }), /Downloaded release asset differs/);
  assert.equal(remote.metadata().draft, true);
  assert(!remote.calls.some(args => args[1] === 'edit'));
});

test('HTTP 403/500 和网络失败不冒充 Release 不存在，也不创建 draft', async t => {
  const f = await fixture(t);
  for (const [failure, expected] of [[http(403, { message: 'Forbidden' }), /HTTP 403/], [http(500, {}), /HTTP 500/], [{ code: 1, stdout: '', stderr: 'network failed' }, /without an HTTP response/]]) {
    const remote = await fakeGithub(f, { apiFailure: failure });
    await assert.rejects(publishRelease({ ...f, gh: remote.gh }), expected);
    assert.equal(remote.mutations().length, 0);
  }
});

test('读取 latest 被拒绝时不把当前 draft 误发布为最新稳定版', async t => {
  const f = await fixture(t);
  const remote = await fakeGithub(f, { apiFailure: http(403, {}), failLatestOnly: true });
  await assert.rejects(publishRelease({ ...f, gh: remote.gh }), /HTTP 403/);
  assert.equal(remote.metadata().draft, true);
  assert(!remote.calls.some(args => args[1] === 'edit'));
});

test('本地 SHA256 损坏在所有 GitHub 调用前被拒绝', async t => {
  const f = await fixture(t);
  await writeFile(join(f.distDir, f.name), 'changed package');
  const remote = await fakeGithub(f);
  await assert.rejects(publishRelease({ ...f, gh: remote.gh }), /SHA256 sidecar/);
  assert.equal(remote.calls.length, 0);
});

test('catalog 版本、地址、摘要、大小、commit、兼容和权限必须匹配本次构建', async t => {
  const f = await fixture(t);
  const changes = [
    entry => { entry.version = '9.0.0'; },
    entry => { entry.url = 'https://example.com/other.piplug'; },
    entry => { entry.shasum = '0'.repeat(64); },
    entry => { entry.sizeBytes++; },
    entry => { entry.provenance.sourceCommit = 'b'.repeat(40); },
    entry => { entry.provenance.sourceRef = 'refs/heads/main'; },
    entry => { entry.provenance.sourceRepository = 'https://github.com/example/example'; },
    entry => { entry.minPiDesktop = '>=0.17.0'; },
    entry => { entry.permissions = ['shell.exec']; },
    entry => { entry.fs.write.scope = ['*']; },
    entry => { entry.net.domains = ['example.com']; },
  ];
  for (const mutate of changes) {
    const catalog = structuredClone(f.catalog); mutate(catalog.plugins[0].versions[0]);
    await writeFile(join(f.distDir, 'catalog.json'), JSON.stringify(catalog));
    const remote = await fakeGithub(f);
    await assert.rejects(publishRelease({ ...f, gh: remote.gh }), /Catalog/);
    assert.equal(remote.calls.length, 0);
  }
});

test('多余本地或远端附件不会被静默上传或公开', async t => {
  const f = await fixture(t);
  await writeFile(join(f.distDir, 'private.txt'), 'do not publish');
  await assert.rejects(validateReleaseAssets(f), /exactly the package/);
  await rm(join(f.distDir, 'private.txt'));
  for (const existing of ['draft', 'public']) {
    const remote = await fakeGithub(f, { existing, unexpectedAsset: true });
    await assert.rejects(publishRelease({ ...f, gh: remote.gh }), /unexpected assets|exactly the three/);
    assert.equal(remote.mutations().length, 0);
  }
});

test('SemVer 比较数字、预发布及稳定版优先级；拒绝非规范 tag', () => {
  const sequence = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 1; i < sequence.length; i++) {
    assert.equal(compareVersions(sequence[i - 1], sequence[i]), -1);
    assert.equal(compareVersions(sequence[i], sequence[i - 1]), 1);
  }
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  for (const invalid of ['01.0.0', '1.0.0-01', '1.0.0-alpha..1', '1.0.0+build', 'v1.0.0', '1.0', '1.0.0/../../', '1.0.0-']) assert.throws(() => compareVersions(invalid, '1.0.0'), /semantic version/);
});
