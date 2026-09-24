/**
 * 技术栈画像测试：版本区间、探测器、画像合并与适用性判定。
 *
 * @module dsh-memory-layer/test/stack.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, parseVersion, satisfiesVersion } from '../src/stack/version.js'
import { detectStack, mergeStack } from '../src/stack/detectors.js'
import type { FileView } from '../src/stack/detectors.js'
import { appliesToAllows, stackSummary, stacksCompatible } from '../src/stack/index.js'
import type { StackProfile } from '../src/types.js'

/** 内存文件视图：用一张「路径 → 内容」表模拟工作区。 */
function view(files: Record<string, string>): FileView {
  return {
    root: '/fake',
    async read(relativePath) {
      return files[relativePath]
    },
    async exists(relativePath) {
      return relativePath in files
    },
  }
}

test('版本解析与比较按分段进行', () => {
  assert.deepEqual(parseVersion('v1.20.1-rc.1'), [1, 20, 1])
  assert.equal(compareVersions('1.20.1', '1.20'), 1)
  assert.equal(compareVersions('1.20', '1.20.0'), 0)
  assert.equal(compareVersions('1.9', '1.20'), -1, '不能按字符串比较')
})

test('版本区间支持比较式、波浪号、脱字号与裸前缀', () => {
  assert.equal(satisfiesVersion('1.20.1', '~1.20'), true)
  assert.equal(satisfiesVersion('1.21.0', '~1.20'), false, '~ 只锁定到 minor')
  assert.equal(satisfiesVersion('1.20.5', '>=1.20 <1.21'), true)
  assert.equal(satisfiesVersion('1.21.0', '>=1.20 <1.21'), false)
  assert.equal(satisfiesVersion('1.20.1', '1.20'), true, '裸版本按前缀匹配')
  assert.equal(satisfiesVersion('1.20.1', '1.20.x'), true)
  assert.equal(satisfiesVersion('1.201', '1.20'), false, '前缀按分段而不是按字符串')
  assert.equal(satisfiesVersion('1.99.0', '^1.20'), true)
  assert.equal(satisfiesVersion('2.0.0', '^1.20'), false)
  assert.equal(satisfiesVersion('9.9.9', ''), true, '空约束表示不限制')
})

test('Node 探测器识别语言、框架与版本', async () => {
  const profile = await detectStack(view({
    'package.json': JSON.stringify({
      dependencies: { react: '^18.2.0' },
      devDependencies: { typescript: '^5.0.0' },
    }),
    'tsconfig.json': '{}',
  }))
  assert.deepEqual(profile?.languages, ['javascript', 'typescript'])
  assert.deepEqual(profile?.frameworks, ['react'])
  assert.equal(profile?.frameworkVersions?.react, '^18.2.0')
  assert.equal(profile?.buildTool, 'npm')
})

test('Minecraft 探测器把生态细节翻译成通用画像', async () => {
  const profile = await detectStack(view({
    'fabric.mod.json': JSON.stringify({ depends: { minecraft: '~1.20.1', fabricloader: '>=0.14' } }),
    'gradle.properties': 'minecraft_version=1.20.1\n',
    'build.gradle': 'plugins { id "fabric-loom" }',
  }))
  assert.equal(profile?.ecosystem, 'minecraft')
  assert.deepEqual(profile?.languages, ['java'])
  assert.equal(profile?.versionConstraints?.minecraft, '~1.20')
  assert.equal(profile?.versions?.minecraft, '1.20.1', '精确版本用于判定区间')
  assert.equal(profile?.buildTool, 'gradle')
  assert.ok(profile?.sdks?.some(sdk => sdk.name === 'fabric-loader'))
})

test('通用探测器覆盖非 Node 生态', async () => {
  const profile = await detectStack(view({ 'go.mod': 'module example.com/demo\n' }))
  assert.deepEqual(profile?.languages, ['go'])
  assert.equal(profile?.buildTool, 'go')
})

test('无任何构建清单时画像为空', async () => {
  assert.equal(await detectStack(view({ 'README.md': '# hi' })), undefined)
})

test('画像合并取并集且不重复 SDK', () => {
  const merged = mergeStack(
    { languages: ['java'], buildTool: 'gradle', sdks: [{ name: 'a' }] },
    { languages: ['java', 'kotlin'], frameworks: ['spring-boot'], sdks: [{ name: 'a' }, { name: 'b' }] },
  )
  assert.deepEqual(merged.languages, ['java', 'kotlin'])
  assert.deepEqual(merged.frameworks, ['spring-boot'])
  assert.deepEqual(merged.sdks?.map(sdk => sdk.name), ['a', 'b'])
  assert.equal(merged.buildTool, 'gradle')
})

test('适用性：语言不符直接排除，这是全局域最关键的一道闸门', () => {
  const java: StackProfile = { languages: ['java'] }
  const ts: StackProfile = { languages: ['javascript', 'typescript'] }
  assert.equal(stacksCompatible(java, ts), false)
  assert.equal(stacksCompatible(java, { languages: ['java'], buildTool: 'maven' }), true)
})

test('适用性：生态与版本约束都要满足', () => {
  const record: StackProfile = {
    ecosystem: 'minecraft',
    languages: ['java'],
    versionConstraints: { minecraft: '~1.20' },
  }
  assert.equal(stacksCompatible(record, { languages: ['java'], versions: { minecraft: '1.20.4' } }), true)
  assert.equal(stacksCompatible(record, { languages: ['java'], versions: { minecraft: '1.21.0' } }), false)
  assert.equal(stacksCompatible(record, { languages: ['java'] }), true, '缺少精确版本时放行')
  assert.equal(
    stacksCompatible(record, { ecosystem: 'minecraft', languages: ['kotlin'] }),
    false,
    '语言不符优先排除',
  )
})

test('适用性：任一方画像缺失时不阻断', () => {
  assert.equal(stacksCompatible(undefined, { languages: ['java'] }), true)
  assert.equal(stacksCompatible({ languages: ['java'] }, undefined), true)
})

test('适用性：框架双方都声明时需有交集', () => {
  assert.equal(
    stacksCompatible({ languages: ['java'], frameworks: ['spring-boot'] }, { languages: ['java'], frameworks: ['quarkus'] }),
    false,
  )
  assert.equal(
    stacksCompatible({ languages: ['java'] }, { languages: ['java'], frameworks: ['quarkus'] }),
    true,
    '记录未声明框架时视为通用',
  )
})

test('画像摘要可读', () => {
  assert.equal(stackSummary({ languages: ['java'], frameworks: ['spring-boot'] }), 'java/spring-boot')
  assert.equal(stackSummary({ ecosystem: 'minecraft', languages: ['java'], versions: { minecraft: '1.20.1' } }), 'java, minecraft@1.20.1')
  assert.equal(stackSummary(undefined), '')
})

// ---- appliesTo 闸门（DEF-30）------------------------------------------------
// 此前 `appliesTo` 只写不读：它进了检索语料、也被 technique_get 渲染，但没有任何过滤读它，
// 于是一条标着 `module=settlement` 的逻辑卡在改别的模块时照样注入。判定原则与画像一致：
// 只拦「判得出来且明确不符」的，判不出来一律放行。

test('appliesTo：module 用当前轮的文件证据判定', () => {
  const files = ['src/alpha/order.ts', 'src/alpha/order.test.ts']
  assert.equal(appliesToAllows('module=alpha', { files }), true)
  assert.equal(appliesToAllows('module=settlement', { files }), false, '文件都在 alpha 下')
  assert.equal(appliesToAllows('module=alpha,module=beta', { files }), false, '逗号是多值 AND，beta 对不上')
  assert.equal(appliesToAllows('path=src/alpha', { files }), true)
  // 没有文件证据时不判：宁可多给一条，也不因为「这轮没提那个模块」而静默扣掉知识。
  assert.equal(appliesToAllows('module=settlement', { files: [] }), true)
  assert.equal(appliesToAllows('module=settlement', {}), true)
})

test('appliesTo：能对上精确版本的键才比较，认不出的键不拦', () => {
  const stack: StackProfile = { ecosystem: 'minecraft', languages: ['java'], versions: { minecraft: '1.21.1' } }
  assert.equal(appliesToAllows('mc=1.21.1', { stack }), true, 'mc 是 minecraft 的别名')
  assert.equal(appliesToAllows('mc=1.20.1', { stack }), false)
  assert.equal(appliesToAllows('mc=~1.21', { stack }), true, '区间写法交给 satisfiesVersion')
  assert.equal(appliesToAllows('mc=1.21.1', {}), true, '没有画像时判不出来 → 放行')
  assert.equal(appliesToAllows('react=^18', { stack }), true, '画像里没有这个键 → 放行')
  assert.equal(appliesToAllows('branch=main', { stack }), true, '认不出的键 → 放行，写错键不该让知识消失')
})

test('appliesTo：空值、散文与半截写法都不拦', () => {
  assert.equal(appliesToAllows(undefined, {}), true)
  assert.equal(appliesToAllows('   ', {}), true)
  assert.equal(appliesToAllows('只在结算流程里适用', {}), true, '散文认不出 key=value')
  assert.equal(appliesToAllows('module=settlement', { files: ['src/beta/x.ts'] }), false)
  // 多值里只有一项判得出来：判得出来的那一项说了算，另一项被忽略。
  assert.equal(appliesToAllows('module=beta,branch=main', { files: ['src/beta/x.ts'] }), true)
})
