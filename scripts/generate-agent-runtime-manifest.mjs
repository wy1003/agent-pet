// Run against a lockfile containing the desired SDK versions before removing them
// from application dependencies. Downloads are pinned; no npm is needed at runtime.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const lock = JSON.parse(await readFile(process.argv[2] || 'package-lock.json', 'utf8')).packages;
function resolve(from, name) {
  for (let at = from; ; at = path.posix.dirname(at)) {
    const key = `${at && at !== '.' ? `${at}/` : ''}node_modules/${name}`;
    if (lock[key]) return key;
    if (!at || at === '.') break;
  }
  throw new Error(`Missing locked dependency ${name} from ${from}`);
}
function artifact(directory) {
  const { version, resolved: url, integrity } = lock[directory];
  if (!url?.startsWith('https://registry.npmjs.org/') || !integrity?.startsWith('sha512-')) throw new Error(directory);
  return { directory, version, url, integrity };
}
const providers = {};
for (const [id, name, entry, prefix] of [
  ['codex', '@openai/codex-sdk', 'dist/index.js', '@openai/codex-'],
  ['claude', '@anthropic-ai/claude-agent-sdk', 'sdk.mjs', '@anthropic-ai/claude-agent-sdk-'],
]) {
  const root = `node_modules/${name}`;
  const found = new Set();
  function visit(key) {
    if (found.has(key)) return;
    found.add(key);
    const pkg = lock[key];
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      if (pkg.peerDependenciesMeta?.[dependency]?.optional) continue;
      visit(resolve(key, dependency));
    }
  }
  visit(root);
  const natives = {};
  for (const key of Object.keys(lock).filter(key => key.startsWith(`node_modules/${prefix}`))) {
    const target = key.slice(`node_modules/${prefix}`.length);
    if (!/^(win32|darwin|linux)-(x64|arm64)$/.test(target)) continue;
    const triple = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
      'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
      'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' }[target];
    natives[target] = { ...artifact(key), executable: id === 'claude' ? (target.startsWith('win32') ? 'claude.exe' : 'claude')
      : `vendor/${triple}/bin/${target.startsWith('win32') ? 'codex.exe' : 'codex'}` };
  }
  providers[id] = { version: lock[root].version, sdk: `${root}/${entry}`, packages: [...found].sort().map(artifact), natives };
}
await writeFile('desktop/agents/runtime-manifest.json', `${JSON.stringify(providers, null, 2)}\n`);
console.log(Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, { packages: p.packages.length, targets: Object.keys(p.natives) }])));
