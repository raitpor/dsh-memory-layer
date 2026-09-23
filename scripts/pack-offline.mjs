#!/usr/bin/env node
/**
 * 打一个**离线安装包**：把一个能在断网环境里装起来的 dsh-memory-layer 交给用户。
 *
 * 为什么离线是可行的（而不是「试试看」）：
 *   1. 本插件的运行时依赖是**零** —— 只有 peerDependencies，全部由宿主 dsh 提供；
 *   2. dsh 的 profile 在自己目录里跑 pnpm，且 profile 的 `pnpm-workspace.yaml` 写着
 *      `autoInstallPeers: false`，所以 pnpm 不会去 registry 抓 peer；
 *   3. dsh 的 `plugin add` 就是「pnpm 转发器 + 事后对账 bundles」，因此
 *      `dsh plugin --profile <name> add file:<tarball> --offline` 不需要任何网络。
 *
 * 产物：
 *   dist/<name>-<version>.tgz                    ← npm 包（`pnpm add` 的目标）
 *   dist/<name>-<version>-offline.tar.gz         ← 交给离线用户的那一个文件
 *     ├── INSTALL.md          逐步安装/升级/卸载
 *     ├── install.sh          一条命令装完（含 --offline）
 *     ├── verify.sh           装完自检（不依赖 dsh、不联网）
 *     ├── checksums.txt       sha256
 *     ├── manifest.json       版本、构建时间、逐文件哈希、宿主 peer 范围
 *     └── packages/
 *         ├── <name>-<version>.tgz    ← 供 pnpm/dsh 安装
 *         └── <name>-<version>/       ← 解包后的包，供手工挂载 cordis.patch.yml
 *
 * @module dsh-memory-layer/scripts/pack-offline
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

/**
 * 跑一个命令并把 stdout 返回给调用方。
 *
 * npm 的缓存目录显式指到仓库内的 `.pack-cache`：打包本身不需要网络，
 * 但 npm 会往默认缓存（`~/.npm`）写元数据 —— 在只读或隔离的环境里那一步会直接 EROFS。
 */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, npm_config_cache: join(ROOT, '.pack-cache'), npm_config_audit: 'false', npm_config_fund: 'false' },
    ...options,
  })
}

/** 一个文件的 sha256。 */
async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** 递归列出目录下的相对路径（稳定排序）。 */
async function walk(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await walk(join(dir, entry.name), relative))
    else out.push(relative)
  }
  return out
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const name = pkg.name
const version = pkg.version
const stage = join(DIST, `${name}-${version}-offline`)
const packagesDir = join(stage, 'packages')

await rm(DIST, { recursive: true, force: true })
await mkdir(packagesDir, { recursive: true })

// ---- 1. npm 包（`prepack` 会先跑构建，保证打进去的是新 lib/） -------------------
process.stdout.write(`\n[1/5] npm pack（含 prepack 构建）…\n`)
const packOutput = run('npm', ['pack', '--pack-destination', DIST, '--json'])
// npm 12 的 `--json` 输出是「按包名索引的对象」，更早的版本是数组 —— 两种都要认。
const parsedPack = JSON.parse(packOutput)
const info = Array.isArray(parsedPack) ? parsedPack[0] : Object.values(parsedPack)[0]
if (info === undefined) throw new Error(`npm pack --json 没有返回包信息：${packOutput.slice(0, 400)}`)
const tarball = join(DIST, info.filename)
const tarballName = basename(tarball)

// 包的完整性是离线安装的地基，因此当场校验文件清单而不是事后抽查。
// npm 12 的清单路径是包内相对路径；更早的版本会带 `package/` 前缀 —— 统一去掉再比。
const paths = info.files.map(file => file.path.replace(/^package\//u, ''))
const ALLOWED = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'cordis.patch.yml', 'lib/src/']
const unexpected = paths.filter(path => !ALLOWED.some(prefix => path === prefix || path.startsWith(prefix)))
if (unexpected.length > 0) {
  throw new Error(`离线包混入了不该发布的文件：\n${unexpected.join('\n')}`)
}
for (const wanted of ['package.json', 'lib/src/index.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
  if (!paths.includes(wanted)) {
    throw new Error(`离线包缺少必需文件：${wanted}\n实际清单：\n${paths.join('\n')}`)
  }
}
if (paths.some(path => path.startsWith('lib/') && !path.startsWith('lib/src/'))) {
  throw new Error(`lib/ 下只应发布 src/：\n${paths.filter(path => path.startsWith('lib/')).slice(0, 10).join('\n')}`)
}
process.stdout.write(`      ${tarballName}：${info.files.length} 个文件，${info.size} 字节\n`)

// ---- 2. 解包一份，供「手工挂载 cordis.patch.yml」的路径用 ----------------------
process.stdout.write(`[2/5] 展开一份供手工挂载…\n`)
const unpacked = join(packagesDir, `${name}-${version}`)
await mkdir(unpacked, { recursive: true })
run('tar', ['xzf', tarball, '-C', unpacked, '--strip-components=1'])

// ---- 3. 校验和与清单 ----------------------------------------------------------
process.stdout.write(`[3/5] 生成校验和与清单…\n`)
const packageTarball = join(packagesDir, tarballName)
await writeFile(packageTarball, await readFile(tarball))

const files = await walk(stage)
const entries = []
for (const relative of files) {
  const path = join(stage, relative)
  entries.push({ path: relative, bytes: (await stat(path)).size, sha256: await sha256(path) })
}
const manifest = {
  name,
  version,
  builtAt: new Date().toISOString(),
  node: process.version,
  offline: true,
  host: { peerDependencies: pkg.peerDependencies, engines: pkg.engines },
  note: '运行时零依赖：package.json 只有 peerDependencies，全部由宿主 dsh 提供。',
  files: entries,
}
await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(
  join(stage, 'checksums.txt'),
  `${entries.filter(entry => entry.path !== 'checksums.txt').map(entry => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
)

// ---- 4. 面向离线用户的三份文档/脚本 -------------------------------------------
const installScript = `#!/bin/sh
# 离线安装 dsh-memory-layer ${version}。
#
#   ./install.sh [profile]      # profile 默认 web；也可用 DSH_BIN 指定 dsh 可执行文件
#
# 全程不联网：包就在同目录的 packages/ 里，且本插件没有第三方运行时依赖。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE=\${1:-web}
DSH_BIN=\${DSH_BIN:-dsh}
# dsh 把 profile 放在 $DSH_HOME/profiles 下；未设置时按 dsh 的默认位置 ~/.dsh 猜。
DSH_HOME=\${DSH_HOME:-$HOME/.dsh}
TARBALL="$HERE/packages/${tarballName}"

[ -f "$TARBALL" ] || { echo "找不到 $TARBALL" >&2; exit 1; }
command -v "$DSH_BIN" >/dev/null 2>&1 || { echo "找不到 dsh（可用 DSH_BIN=... 指定）" >&2; exit 1; }

echo "==> 安装 ${name}@${version} 到 profile '$PROFILE'（离线，DSH_HOME=$DSH_HOME）"

# 升级场景：先删掉 profile 里的旧副本。file: 依赖是按硬链接落地的，
# 新增/改名/删除的文件不会被同步，不删干净就可能让 dsh 启动失败（ERR_MODULE_NOT_FOUND）。
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
if [ -d "$PROFILE_DIR/node_modules/${name}" ]; then
  echo "==> 移除旧副本 $PROFILE_DIR/node_modules/${name}"
  rm -rf "$PROFILE_DIR/node_modules/${name}"
elif [ ! -d "$PROFILE_DIR" ]; then
  echo "!! 找不到 $PROFILE_DIR —— 如果这是升级而不是全新安装，请先 export DSH_HOME=<你的 dsh home> 再重跑，" >&2
  echo "   否则旧副本不会被清掉，硬链接不会同步新增/改名的文件。" >&2
fi

"$DSH_BIN" plugin --profile "$PROFILE" add "file:$TARBALL" --offline

echo "==> 自检"
sh "$HERE/verify.sh" "$PROFILE" || true

cat <<'EOT'

==> 完成。最后一步必须由你来做：重启 dsh。
    运行中的实例不会热加载新的 bundle 层（lib/ 重建后同样如此）。

重启后可选核对：让模型调用 memory_stats，应看到 "Memory root:" 与各层计数。
EOT
`

const verifyScript = `#!/bin/sh
# 离线自检：只做静态检查，不依赖 dsh、不联网。
#
#   ./verify.sh [profile]
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE=\${1:-web}
DSH_HOME=\${DSH_HOME:-$HOME/.dsh}
FAIL=0

say() { printf '%s\\n' "$*"; }
bad() { FAIL=1; say "  ✗ $*"; }
ok() { say "  ✓ $*"; }

say "== 离线包自身"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$HERE" && sha256sum -c checksums.txt >/dev/null 2>&1 ) \
    && ok "checksums.txt 全部匹配" || bad "校验和不匹配（包可能在传输中损坏）"
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$HERE" && shasum -a 256 -c checksums.txt >/dev/null 2>&1 ) \
    && ok "checksums.txt 全部匹配（shasum）" || bad "校验和不匹配（包可能在传输中损坏）"
else
  say "  · 没有 sha256sum/shasum，跳过校验和（安装仍可继续）"
fi

say "== 已安装的副本"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/${name}"
if [ ! -d "$PROFILE_DIR" ]; then
  say "  · 找不到 $PROFILE_DIR（DSH_HOME=$DSH_HOME）—— 跳过安装位置检查；"
  say "    位置不同的话请 export DSH_HOME=<你的 dsh home> 后重跑"
elif [ ! -d "$TARGET" ]; then
  bad "未找到 $TARGET —— 安装没有生效？"
else
  for file in lib/src/index.js lib/src/store.js cordis.patch.yml package.json; do
    [ -f "$TARGET/$file" ] && ok "$file" || bad "缺少 $file"
  done
  INSTALLED=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$TARGET/package.json" | head -1)
  [ "$INSTALLED" = "${version}" ] && ok "版本 $INSTALLED" || bad "版本不符：期望 ${version}，实际 $INSTALLED"
  # 语法自检：能发现被截断/损坏的产物，且不需要解析 peer 依赖。
  if command -v node >/dev/null 2>&1; then
    BAD=0
    for file in $(find "$TARGET/lib/src" -name '*.js'); do
      node --check "$file" >/dev/null 2>&1 || { bad "语法错误：$file"; BAD=1; }
    done
    [ "$BAD" = 0 ] && ok "lib/src 下全部 .js 通过 node --check"
  fi
fi

say ""
[ "$FAIL" = 0 ] && say "自检通过。" || say "自检发现问题，见上面的 ✗。"
exit "$FAIL"
`

const installDoc = `# 离线安装 ${name} ${version}

本包用于**没有外网**的环境。全程不需要 npm/pnpm registry，也不需要访问 GitHub。

## 为什么可以离线

- 本插件的**运行时依赖为零**：\`package.json\` 里只有 \`peerDependencies\`，而它们全部由宿主 dsh 提供。
- dsh 的 \`plugin\` 命令是 pnpm 的转发器，它会**在 profile 目录里**执行 pnpm；
  而 profile 自带的 \`pnpm-workspace.yaml\` 设置了 \`autoInstallPeers: false\`，
  所以 pnpm 不会去 registry 抓 peer 依赖。
- 因此安装动作只需要本地的一个 tarball：\`pnpm add file:<tarball>\`。

## 前置条件

| 项 | 要求 |
|---|---|
| dsh | 已装好并可执行（\`dsh --version\`） |
| Node | ${pkg.engines?.node ?? '>=20'}（与 dsh 自身一致即可） |
| 宿主依赖 | \`peerDependencies\` 需与 dsh 版本线一致：${Object.entries(pkg.peerDependencies ?? {}).map(([k, v]) => `${k}@${v}`).join('、')} |

版本不符不会在安装时报错，但插件可能静默失效（它按「软探测降级」设计）。装在错误的 dsh 版本上时，
先跑一次自检并观察重启后的日志。

## 方式一：一条命令（推荐）

\`\`\`sh
tar xzf ${name}-${version}-offline.tar.gz
cd ${name}-${version}-offline
./install.sh web          # 换成你的 profile 名；默认 web
# 然后重启 dsh
\`\`\`

## 方式二：手工两步

\`\`\`sh
# 1. 安装（--offline 强制只走本地，任何联网尝试都会立刻失败，便于确认真的没联网）
dsh plugin --profile web add "file:$PWD/packages/${tarballName}" --offline
# 2. 自检
DSH_HOME=<你的 dsh home> sh verify.sh web
\`\`\`

装完必须**重启 dsh**：运行中的实例不会热加载新的 bundle 层。

## 方式三：离线升级

\`file:\` 依赖在 profile 里是**硬链接**：改写已有文件会同步，但**新增 / 改名 / 删除**的文件不会。
所以升级不能只覆盖文件，必须删掉旧副本再装：

\`\`\`sh
rm -rf "\${DSH_HOME}/profiles/web/node_modules/${name}"
dsh plugin --profile web add "file:$PWD/packages/${tarballName}" --offline
# 重启 dsh
\`\`\`

\`./install.sh\` 已经包含这一步（检测到旧副本就会先删）。

## 方式四：手工挂载 cordis.patch.yml（不走包管理器）

适合完全不允许改 profile 依赖的场合。把 \`packages/${name}-${version}/\` 解到任意目录，
然后在该 profile 的 \`cordis.patch.yml\` 里用**绝对路径**挂载：

\`\`\`yaml
- insert:
    - id: ${name}
      name: '/opt/${name}-${version}'    # 绝对路径，指向解包后的目录
      config:
        # 只写要改的字段也可以，但 patch 行的 config 是**整体替换**：
        # 没写的字段会回落 schema 默认值。
        encrypt: true
\`\`\`

这种方式下插件不在 \`node_modules\` 里，因此也不受硬链接同步问题影响；升级 = 换目录 + 重启。

## 卸载

\`\`\`sh
dsh plugin --profile web remove ${name}
# 手工挂载的场合：删掉 cordis.patch.yml 里对应的 insert 条目
# 记忆库数据默认在 \${DSH_HOME}/memory-layer，卸载不会删除它；要清空请自行删除该目录。
\`\`\`

## 安装后核对

1. \`sh verify.sh <profile>\`：静态检查（文件齐全、版本一致、\`node --check\` 全过）。
2. 重启后让模型调用 \`memory_stats\`，应看到 \`Memory root:\` 与各层计数。
3. 若 \`memory_stats\` 报 \`Store integrity: BROKEN\`，说明记忆库密钥与密文不匹配 ——
   **先恢复密钥，不要继续写入**（详见包内 README 的「存储布局」与「已知限制」）。

## 本包内容

| 路径 | 说明 |
|---|---|
| \`packages/${tarballName}\` | npm 包本体（安装用的就是它） |
| \`packages/${name}-${version}/\` | 同一份内容的解包形式，供手工挂载 |
| \`manifest.json\` | 版本、构建时间、逐文件大小与 sha256、宿主 peer 范围 |
| \`checksums.txt\` | 逐文件 sha256（\`sha256sum -c\` 可直接校验） |
| \`install.sh\` / \`verify.sh\` | 安装与自检脚本（POSIX sh） |
`

await writeFile(join(stage, 'install.sh'), installScript, { mode: 0o755 })
await writeFile(join(stage, 'verify.sh'), verifyScript, { mode: 0o755 })
await writeFile(join(stage, 'INSTALL.md'), installDoc)
await writeFile(join(stage, '.gitattributes'), '* text=auto\n*.sh text eol=lf\n')

// ---- 5. 打成给用户的那一个文件 ------------------------------------------------
process.stdout.write(`[4/5] 打包 offline.tar.gz…\n`)
const bundle = join(DIST, `${name}-${version}-offline.tar.gz`)
run('tar', ['czf', bundle, '-C', DIST, `${name}-${version}-offline`], { cwd: DIST })
await rm(tarball, { force: true })     // 顶层只留 bundle，避免「该发哪个」的歧义

// ---- 报告 --------------------------------------------------------------------
process.stdout.write(`[5/5] 完成\n\n`)
const bundleStat = await stat(bundle)
const bundleHash = await sha256(bundle)
await writeFile(`${bundle}.sha256`, `${bundleHash}  ${basename(bundle)}\n`)
process.stdout.write(`  ${basename(bundle)}  ${bundleStat.size} 字节\n`)
process.stdout.write(`    sha256 ${bundleHash}\n`)
process.stdout.write(`    校验文件 ${basename(bundle)}.sha256\n`)
process.stdout.write(`    内含 ${entries.length} 个文件，清单见 manifest.json\n\n`)
