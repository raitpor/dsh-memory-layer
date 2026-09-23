#!/usr/bin/env node
/**
 * 离线安装的**真验证**：把打包产物在一个「类 profile」的干净目录里装一遍。
 *
 * 只跑 `--offline` 还不够 —— 那只是让 pnpm 自己声明不联网。这里同时把 registry 指向一个
 * **不可路由的地址**，所以只要 pnpm 真的尝试过任何网络请求，就会以连接失败告终。
 *
 * 步骤：解包 → 造一个和真实 profile 同配置的目录（`nodeLinker: hoisted`、
 * `autoInstallPeers: false`）→ `pnpm add file:<tarball>` → 校验落地产物与清单 →
 * 跑 `node --check` → 再跑包里的 `verify.sh`。
 *
 * 用法：node scripts/verify-offline-install.mjs [bundle.tar.gz]
 *
 * @module dsh-memory-layer/scripts/verify-offline-install
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

/** 断言，失败即抛出（CI 里就是这一步拦住问题包）。 */
function check(condition, message, detail = '') {
  if (condition) {
    process.stdout.write(`  ✓ ${message}\n`)
    return
  }
  throw new Error(`${message}${detail.length === 0 ? '' : `\n${detail}`}`)
}

/** 找到要验证的 bundle：显式传参优先，否则取 dist 下最新的一个。 */
async function findBundle() {
  if (process.argv[2] !== undefined) return resolve(process.argv[2])
  const entries = (await readdir(DIST)).filter(name => name.endsWith('-offline.tar.gz'))
  if (entries.length === 0) throw new Error(`dist/ 下没有 *-offline.tar.gz，先跑 npm run pack:offline`)
  const withTime = await Promise.all(entries.map(async name => ({ name, time: (await stat(join(DIST, name))).mtimeMs })))
  withTime.sort((left, right) => right.time - left.time)
  return join(DIST, withTime[0].name)
}

const bundle = await findBundle()
process.stdout.write(`\n离线安装验证：${basename(bundle)}\n`)

const work = await mkdtemp(join(tmpdir(), 'offline-install-'))
try {
  // ---- 1. 解包 ---------------------------------------------------------------
  process.stdout.write('\n[1/5] 解包与清单\n')
  execFileSync('tar', ['xzf', bundle, '-C', work])
  const stage = join(work, `${pkg.name}-${pkg.version}-offline`)
  const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'))
  check(manifest.version === pkg.version, `manifest 版本与 package.json 一致（${pkg.version}）`)
  const tarballEntry = manifest.files.find(file => file.path === `packages/${pkg.name}-${pkg.version}.tgz`)
  check(tarballEntry !== undefined, '清单里有 npm tarball')
  const tarball = join(stage, `packages/${pkg.name}-${pkg.version}.tgz`)
  const actual = createHash('sha256').update(await readFile(tarball)).digest('hex')
  check(actual === tarballEntry.sha256, 'npm tarball 的 sha256 与清单一致')

  // ---- 2. 造一个和真实 profile 同配置的干净目录 -------------------------------
  process.stdout.write('\n[2/5] 准备类 profile 目录（hoisted + 不自动装 peer）\n')
  const profile = join(work, 'profile')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({ name: 'offline-install-test', private: true, version: '0.0.0' }, null, 2)}\n`)
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

  // ---- 3. 离线安装（registry 指向不可路由地址，任何联网都会立刻失败）----------
  process.stdout.write('\n[3/5] pnpm add file:<tarball>（离网环境模拟）\n')
  // 把 store 与 HOME 都关进临时目录：既让这一步可重复，也顺带证明
  // 「一个**空 store** + 断网」就足以装好 —— 这正是离线用户的处境。
  const store = join(work, 'store')
  const env = {
    ...process.env,
    HOME: work,
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_store_dir: store,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    CI: '1',
  }
  try {
    execFileSync('pnpm', ['add', `file:${tarball}`, '--offline', '--store-dir', store], { cwd: profile, env, stdio: 'pipe', encoding: 'utf8' })
    check(true, 'pnpm add 成功（零网络请求）')
  } catch (error) {
    throw new Error(`离线安装失败：\n${error.stdout ?? ''}${error.stderr ?? ''}`)
  }

  // ---- 4. 校验落地产物 -------------------------------------------------------
  process.stdout.write('\n[4/5] 校验落地产物\n')
  const installed = join(profile, 'node_modules', pkg.name)
  const installedPkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  check(installedPkg.version === pkg.version, `已安装版本 = ${pkg.version}`)
  for (const file of ['lib/src/index.js', 'lib/src/store.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'package.json']) {
    check(await exists(join(installed, file)), `已安装 ${file}`)
  }
  // 语法自检：能发现被截断的产物，且不需要解析 peer 依赖。
  const jsFiles = await collect(join(installed, 'lib/src'), file => file.endsWith('.js'))
  for (const file of jsFiles) execFileSync('node', ['--check', file], { stdio: 'pipe' })
  check(jsFiles.length > 0, `${jsFiles.length} 个 .js 全部通过 node --check`)
  // profile 侧也要能识别这个包（dsh 的 bundles 对账读的就是它）。
  const profilePkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  check(
    typeof profilePkg.dependencies?.[pkg.name] === 'string' && profilePkg.dependencies[pkg.name].startsWith('file:'),
    'profile 的 dependencies 里登记为 file: 依赖',
  )

  // ---- 5. 跑包里自带的 verify.sh（把 DSH_HOME 指到临时 home）------------------
  process.stdout.write('\n[5/5] 运行包内 verify.sh\n')
  const fakeHome = join(work, 'dsh-home')
  await mkdir(join(fakeHome, 'profiles', 'web', 'node_modules'), { recursive: true })
  await cp(installed, join(fakeHome, 'profiles', 'web', 'node_modules', pkg.name), { recursive: true })
  const out = execFileSync('sh', [join(stage, 'verify.sh'), 'web'], {
    env: { ...process.env, DSH_HOME: fakeHome },
    encoding: 'utf8',
  })
  process.stdout.write(out.replace(/^/gmu, '    '))
  check(!out.includes('✗'), 'verify.sh 自检无失败项')

  // ---- 6. 跑用户实际会用的 install.sh ----------------------------------------
  // dsh 的 plugin 命令就是「pnpm 转发器 + 事后对账 bundles」，所以这里用一个只做参数
  // 转发的 dsh 替身即可：能验证脚本本身（旧副本清理、--offline 传递、路径带空格…）。
  process.stdout.write('\n[6/6] 运行 install.sh（dsh 用替身，只做参数转发）\n')
  const binDir = join(work, 'bin')
  const outerHome = join(work, 'outer-home')
  const outerProfile = join(outerHome, 'profiles', 'web')
  await mkdir(join(outerProfile, 'node_modules', pkg.name), { recursive: true })
  await writeFile(join(outerProfile, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, version: '0.0.0' }, null, 2)}\n`)
  await writeFile(join(outerProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  // 造一个「旧副本」：install.sh 必须先把它删掉，否则硬链接不会同步新增/改名的文件。
  await writeFile(join(outerProfile, 'node_modules', pkg.name, 'STALE'), 'stale\n')
  await mkdir(binDir, { recursive: true })
  const stub = join(binDir, 'dsh')
  await writeFile(stub, `#!/bin/sh
# 只实现 dsh plugin --profile <name> <args...>：丢掉自己的 flag，其余原样转给 pnpm。
[ "$1" = "plugin" ] || { echo "stub 只支持 plugin 子命令" >&2; exit 2; }
PROFILE="$3"
shift 3
cd "$DSH_HOME/profiles/$PROFILE" || exit 2
exec pnpm "$@" --store-dir "$DSH_HOME/store"
`, { mode: 0o755 })
  const installOut = execFileSync('sh', [join(stage, 'install.sh'), 'web'], {
    env: { ...process.env, DSH_HOME: outerHome, DSH_BIN: stub, PATH: `${binDir}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  process.stdout.write(installOut.replace(/^/gmu, '    '))
  check(!await exists(join(outerProfile, 'node_modules', pkg.name, 'STALE')), 'install.sh 清掉了旧副本')
  check(await exists(join(outerProfile, 'node_modules', pkg.name, 'lib/src/index.js')), 'install.sh 装上了新副本')
  const outerInstalled = JSON.parse(await readFile(join(outerProfile, 'node_modules', pkg.name, 'package.json'), 'utf8'))
  check(outerInstalled.version === pkg.version, `install.sh 装出的版本 = ${pkg.version}`)

  process.stdout.write(`\n离线安装验证通过：${basename(bundle)}\n\n`)
} finally {
  await rm(work, { recursive: true, force: true })
}

/** 判断路径是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 递归收集满足条件的文件。 */
async function collect(dir, predicate) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await collect(path, predicate))
    else if (predicate(path)) out.push(path)
  }
  return out
}
