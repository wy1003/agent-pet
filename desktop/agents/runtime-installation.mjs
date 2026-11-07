import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { x as extractTar } from 'tar';
import { resolveCodexExecutable } from '../codex-runtime.mjs';
import { resolveClaudeExecutable } from '../claude/runtime.mjs';

const manifest = JSON.parse(await readFile(new URL('./runtime-manifest.json', import.meta.url), 'utf8'));
const applicationRoot = fileURLToPath(new URL('../../', import.meta.url));
const exists = file => access(file).then(() => true, () => false);

export async function extractRuntimeArchive(file, directory) {
  let size = 0, entries = 0, unsafe = false;
  await extractTar({ file, cwd: directory, strip: 1, strict: true, preservePaths: false,
    filter(name, entry) {
      const parts = name.replaceAll('\\', '/').split('/');
      const safe = parts[0] === 'package' && !parts.includes('..') && !name.includes(':')
        && ['File', 'Directory', 'OldFile'].includes(entry.type)
        && ++entries < 50_000 && (size += entry.size || 0) < 1024 ** 3;
      if (!safe) unsafe = true;
      return safe;
    },
  });
  if (unsafe) throw new Error('组件压缩包包含不支持的文件或超出大小限制。');
}

export class AgentRuntimeInstallation {
  constructor({ root, getPreferences, fetch = globalThis.fetch, catalog = manifest,
    sourceRoot = applicationRoot, platform = process.platform, arch = process.arch,
    resolveLocal, probe = async file => {
      const { stdout } = await promisify(execFile)(file, ['--version'], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
      if (!/\d+\.\d+/.test(stdout)) throw new Error('运行组件未返回有效版本。');
    } }) {
    Object.assign(this, { root, getPreferences, fetch, catalog, sourceRoot, platform, arch, probe });
    this.resolveLocal = resolveLocal || (id => id === 'codex'
      ? resolveCodexExecutable('', { requireExisting: true, bundledExecutable: '' })
      : resolveClaudeExecutable(getPreferences()?.claude?.executablePath || '', { bundledExecutable: '' }));
    this.ready = new Map();
  }
  definition(id) {
    if (!Object.hasOwn(this.catalog, id)) throw new TypeError('未知智能体');
    return this.catalog[id];
  }
  directory(id) { return path.join(this.root, id, this.definition(id).version); }
  async inspect(id) {
    // Read-only inventory: opening settings must not install or download anything.
    const definition = this.definition(id);
    const packageRoot = async pkg => {
      const cached = path.join(this.directory(id), pkg.directory);
      if (await readFile(path.join(cached, '.agent-pet-integrity'), 'utf8').catch(() => '') === pkg.integrity
        && await exists(path.join(cached, 'package.json'))) return cached;
      const source = path.join(this.sourceRoot, pkg.directory);
      const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8').catch(() => '{}'));
      return metadata.version === pkg.version ? source : '';
    };
    for (const pkg of definition.packages) if (!await packageRoot(pkg)) return 'missing';
    const sdkPackage = definition.packages.find(pkg => definition.sdk.startsWith(`${pkg.directory}/`));
    const sdkRoot = sdkPackage && await packageRoot(sdkPackage);
    if (!sdkRoot || !await exists(path.join(sdkRoot, definition.sdk.slice(sdkPackage.directory.length + 1)))) return 'missing';
    if (await this.resolveLocal(id)) return 'ready';
    const native = definition.natives[`${this.platform}-${this.arch}`];
    const nativeRoot = native && await packageRoot(native);
    return nativeRoot && await exists(path.join(nativeRoot, native.executable)) ? 'ready' : 'missing';
  }
  async #package(id, pkg, { allowDownload, signal, onProgress }) {
    const root = this.directory(id);
    const destination = path.join(root, pkg.directory);
    const marker = path.join(destination, '.agent-pet-integrity');
    if (await readFile(marker, 'utf8').catch(() => '') === pkg.integrity && await exists(path.join(destination, 'package.json'))) return;
    const source = path.join(this.sourceRoot, pkg.directory);
    const local = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8').catch(() => '{}'));
    if (local.version !== pkg.version && !allowDownload) throw new Error('连接组件缺失，请点击连接以下载。');
    signal?.throwIfAborted();
    const staging = path.join(root, `.install-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    const archive = `${staging}.tgz`;
    try {
      if (local.version === pkg.version) {
        await cp(source, staging, { recursive: true, filter: file => file === source || path.basename(file) !== 'node_modules' });
      } else {
        if (!pkg.url.startsWith('https://registry.npmjs.org/') || !pkg.integrity.startsWith('sha512-')) throw new Error('无效组件来源。');
        onProgress({ phase: 'downloading', package: pkg.directory, received: 0 });
        const response = await this.fetch(pkg.url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10 * 60_000)]), redirect: 'error' });
        if (!response.ok || !response.body) throw new Error(`组件下载失败（HTTP ${response.status}），请重试。`);
        const total = Number(response.headers.get('content-length')) || 0;
        const hash = createHash('sha512');
        let received = 0, lastUpdate = 0;
        await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
          received += chunk.length;
          if (received > 512 * 1024 ** 2) return done(new Error('组件下载超出大小限制。'));
          hash.update(chunk);
          if (Date.now() - lastUpdate > 150) { lastUpdate = Date.now(); onProgress({ phase: 'downloading', package: pkg.directory, received, total }); }
          done(null, chunk);
        } }), createWriteStream(archive), { signal });
        if (`sha512-${hash.digest('base64')}` !== pkg.integrity) throw new Error('组件完整性校验失败，请重试。');
        onProgress({ phase: 'installing', package: pkg.directory });
        await extractRuntimeArchive(archive, staging);
      }
      signal?.throwIfAborted();
      const installed = JSON.parse(await readFile(path.join(staging, 'package.json'), 'utf8'));
      if (installed.version !== pkg.version) throw new Error('组件版本与下载清单不一致。');
      await writeFile(path.join(staging, '.agent-pet-integrity'), pkg.integrity);
      await mkdir(path.dirname(destination), { recursive: true });
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  }
  async prepare(id, { allowDownload = false, signal, onProgress = () => {} } = {}) {
    const definition = this.definition(id), root = this.directory(id);
    const options = { allowDownload, signal, onProgress };
    onProgress({ phase: 'checking' });
    let executable = await this.resolveLocal(id);
    // An explicitly configured runtime is never silently replaced by a download.
    if (executable) await this.probe(executable);
    // Publish parents before nested dependencies: atomically replacing a parent
    // must never erase a child which another worker just installed.
    const depth = pkg => pkg.directory.split('/node_modules/').length;
    for (const level of [...new Set(definition.packages.map(depth))].sort((a, b) => a - b)) {
      const packages = definition.packages.filter(pkg => depth(pkg) === level);
      let next = 0, failed = false;
      const results = await Promise.allSettled(Array.from({ length: Math.min(4, packages.length) }, async () => {
        while (next < packages.length) {
          if (failed) return;
          const pkg = packages[next++];
          signal?.throwIfAborted();
          try { await this.#package(id, pkg, options); }
          catch (error) { failed = true; throw error; }
        }
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
    if (!executable) {
      const native = definition.natives[`${this.platform}-${this.arch}`];
      if (!native) throw new Error('当前系统没有可下载的运行组件，请先安装对应智能体。');
      executable = path.join(root, native.directory, native.executable);
      if (!await exists(executable)) await rm(path.join(root, native.directory, '.agent-pet-integrity'), { force: true });
      await this.#package(id, native, options);
      await this.probe(executable);
    }
    signal?.throwIfAborted();
    const sdk = pathToFileURL(path.join(root, definition.sdk)).href;
    const module = await import(sdk);
    if (typeof module[id === 'codex' ? 'Codex' : 'query'] !== 'function') throw new Error('智能体连接组件无法加载，请重试。');
    const value = { executable, sdk, module };
    this.ready.set(id, value);
    return value;
  }
  get(id) {
    const value = this.ready.get(id);
    if (!value) throw new Error('请先在“智能体与 AI”中连接该智能体。');
    return value;
  }
}
