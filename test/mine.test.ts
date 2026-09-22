/**
 * 代码挖掘测试：忽略规则、扫描边界、结构聚类、规则/模型双路径、增量缓存与泄漏闸门。
 *
 * 覆盖设计 §16 P3 的全部验收标准。夹具用一个**多语言假仓库**（Java + TypeScript + Gradle），
 * 因为「真实多语言仓库产出 ≥5 条带证据草稿」正是要证明的能力。
 *
 * @module dsh-memory-layer/test/mine.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeSource,
  cacheHit,
  classifyRole,
  clusterSymbols,
  contentHash,
  emptyMineCache,
  finalizeCandidate,
  isAnalyzable,
  isIgnored,
  languageOf,
  mineRepository,
  parseIgnoreLines,
  ruleCandidate,
  scanRepository,
  withCacheEntries,
} from '../src/mine.js'
import type { RepoView, ScannedFile } from '../src/mine.js'
import { leakCheck, wordSequence } from '../src/abstract.js'
import type { StackProfile } from '../src/types.js'

/** 用一张「路径 → 内容」表造出工作区视图。 */
function repoView(files: Record<string, string>): RepoView {
  const tree = new Map<string, { name: string; dir: boolean }[]>()
  const ensure = (dir: string): { name: string; dir: boolean }[] => {
    let bucket = tree.get(dir)
    if (bucket === undefined) {
      bucket = []
      tree.set(dir, bucket)
    }
    return bucket
  }
  ensure('')
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    let dir = ''
    for (const [index, part] of parts.entries()) {
      const isFile = index === parts.length - 1
      const bucket = ensure(dir)
      if (!bucket.some(entry => entry.name === part)) bucket.push({ name: part, dir: !isFile })
      dir = dir.length === 0 ? part : `${dir}/${part}`
    }
  }
  return {
    root: '/fake-repo',
    async list(relativeDir) {
      const bucket = tree.get(relativeDir)
      if (bucket === undefined) throw new Error('ENOENT')
      return bucket
    },
    async read(relativePath) {
      return files[relativePath]
    },
  }
}

/** 夹具仓库：一个 Java 后端 + 一个 TS 前端 + Gradle 构建，外加必须被跳过的目录。 */
const FIXTURE: Record<string, string> = {
  '.gitignore': 'secret/\n*.log\n',
  'build.gradle': 'plugins { id "fabric-loom" }\ndependencies { }\n',
  'src/main/java/com/acme/orders/OrderService.java': `
package com.acme.orders;
import com.acme.client.OrdersClient;
public class OrderService {
  @Override
  public void submit(Order order) {
    OrdersClient.authorize(order.token());
    OrdersClient.create(order);
    OrdersClient.create(order.withRetry());
    Metrics.record("order.submit");
    Metrics.record("order.submitted");
    if (order.total() < 0) throw new IllegalArgumentException("negative total");
    if (order.items().isEmpty()) return;
  }
}
`,
  'src/main/java/com/acme/orders/OrderPolicy.java': `
package com.acme.orders;
public class OrderPolicy {
  public boolean canCancel(Order order) {
    Validator.require(order.id(), "id");
    Validator.require(order.user(), "user");
    if (order.state() == State.SHIPPED) return false;
    if (order.paid() == false) throw new IllegalStateException("unpaid");
    return true;
  }
}
`,
  'src/main/java/com/acme/client/OrdersClient.java': `
package com.acme.client;
public class OrdersClient {
  public static void authorize(String token) { }
  public static Order create(Order order) { return order; }
  public static void close() { }
}
`,
  'src/app/handler.ts': `
import { EventBus } from './bus'
import { client } from './client'
export function handle(event: Event) {
  client.send(event.payload)
  client.send(event.payload, { retry: true })
  EventBus.publish('order.created', event)
  EventBus.publish('order.updated', event)
  if (!event.id) throw new Error('missing id')
}
`,
  'src/util/logger.ts': `
export const log = (message: string) => {
  Logger.info(message)
  Logger.info(message + '!')
  Logger.info(message + '?')
}
`,
  'node_modules/junk/index.js': 'JunkCall.never()\nJunkCall.never()\nJunkCall.never()\n',
  'secret/keys.ts': 'export const API_KEY = "sk-live-1234567890abcdefGHIJKL"\n',
  'build/output.js': 'Generated.call()\nGenerated.call()\n',
}

/** 一个 Java 技术栈，供候选标注使用。 */
const JAVA_STACK: StackProfile = { languages: ['java'], buildTool: 'gradle' }

test('忽略规则：注释、目录限定、反选与通配', () => {
  const rules = parseIgnoreLines(['# comment', '', 'secret/', '*.log', '!keep.log', 'build/output.js'])
  assert.equal(isIgnored('secret', true, rules), true)
  assert.equal(isIgnored('src/secret', true, rules), true, '未锚定的目录名匹配任意层级')
  assert.equal(isIgnored('secret/keys.ts', false, rules), false, '目录限定规则不匹配文件本身')
  assert.equal(isIgnored('a/b/debug.log', false, rules), true)
  assert.equal(isIgnored('a/b/keep.log', false, rules), false, '反选规则覆盖前者')
  assert.equal(isIgnored('build/output.js', false, rules), true)
  assert.equal(isIgnored('src/main.ts', false, rules), false)
})

test('角色与语言识别兼顾目录名与类名', () => {
  assert.equal(classifyRole('src/main/java/com/acme/orders/OrderService.java'), 'service-layer')
  assert.equal(classifyRole('src/main/java/com/acme/orders/OrderPolicy.java'), 'domain-model')
  assert.equal(classifyRole('src/main/java/com/acme/client/OrdersClient.java'), 'api-client')
  assert.equal(classifyRole('src/app/handler.ts'), 'service-layer')
  assert.equal(classifyRole('build.gradle'), 'build-config')
  assert.equal(classifyRole('test/OrderServiceTest.java'), 'test')
  assert.equal(languageOf('src/app/handler.ts'), 'typescript')
  assert.equal(languageOf('build.gradle'), 'groovy')
  assert.equal(isAnalyzable('src/app/handler.ts'), true)
  assert.equal(isAnalyzable('assets/logo.png'), false)
})

test('扫描跳过依赖、忽略目录与构建产物，并守住文件数上限', async () => {
  const scan = await scanRepository(repoView(FIXTURE), { maxFiles: 100, maxBytes: 100_000 })
  const paths = scan.files.map(file => file.path)
  assert.ok(!paths.some(path => path.startsWith('node_modules/')), '依赖目录必须跳过')
  assert.ok(!paths.some(path => path.startsWith('secret/')), '.gitignore 必须生效')
  assert.ok(!paths.some(path => path.startsWith('build/')), '构建产物必须跳过')
  assert.ok(paths.includes('build.gradle'))
  assert.ok(paths.includes('src/app/handler.ts'))

  const limited = await scanRepository(repoView(FIXTURE), { maxFiles: 3, maxBytes: 100_000 })
  assert.equal(limited.files.length, 3, '文件数上限必须生效')

  const oversized = await scanRepository(repoView(FIXTURE), { maxFiles: 100, maxBytes: 32 })
  assert.ok(oversized.skippedLarge > 0, '超限文件应被记为跳过而不是读入')
})

test('结构分析抽取调用点、守卫与注解', () => {
  const file: ScannedFile = {
    path: 'src/main/java/com/acme/orders/OrderService.java',
    role: 'service-layer',
    language: 'java',
    content: FIXTURE['src/main/java/com/acme/orders/OrderService.java'] as string,
  }
  const facts = analyzeSource(file)
  const symbols = facts.calls.map(call => call.symbol)
  assert.ok(symbols.includes('OrdersClient.authorize'))
  assert.ok(symbols.includes('OrdersClient.create'))
  assert.ok(symbols.includes('order.withRetry'), '链式调用也应被识别')
  assert.equal(facts.calls.find(call => call.symbol === 'OrdersClient.authorize')?.arity, 1)
  assert.ok(facts.guards.length >= 1, '守卫语句应被抽取')
  assert.ok(facts.annotations.includes('@Override'), '注解应被抽取')
  assert.ok(!symbols.includes('submit'), '单个标识符的调用不当作候选（噪声太大）')

  const policy = analyzeSource({
    path: 'src/main/java/com/acme/orders/OrderPolicy.java',
    role: 'domain-model',
    language: 'java',
    content: FIXTURE['src/main/java/com/acme/orders/OrderPolicy.java'] as string,
  })
  assert.ok(policy.guards.length >= 2, '同一文件的多条守卫都应被抽取')
})

test('调用聚类要求最小出现次数，并按次数排序', () => {
  const facts = Object.entries(FIXTURE)
    .filter(([path]) => isAnalyzable(path) && !path.startsWith('node_modules/') && !path.startsWith('secret/'))
    .map(([path, content]) => analyzeSource({
      path, role: classifyRole(path), language: languageOf(path), content,
    }))
  const clusters = clusterSymbols(facts, 2)
  const symbols = clusters.map(cluster => cluster.symbol)
  assert.ok(symbols.includes('OrdersClient.create'))
  assert.ok(symbols.includes('EventBus.publish'))
  assert.equal(clusters[0]?.symbol, 'Logger.info', '出现 3 次的符号应排在前列')
  assert.ok(clusters.every(cluster => cluster.occurrences >= 2))
})

test('P3-① 多语言仓库产出 ≥5 条带证据草稿', async () => {
  const outcome = await mineRepository({
    view: repoView(FIXTURE),
    stack: JAVA_STACK,
    cache: emptyMineCache(),
    model: '',
    options: {
      maxFiles: 100, maxBytes: 100_000, minOccurrences: 2, maxModelCalls: 0,
      exampleMaxLines: 8, exampleMaxChars: 480, timeoutMs: 10_000,
    },
  })
  const apiCandidates = outcome.candidates.filter(candidate => candidate.draft.kind === 'api-usage')
  assert.ok(apiCandidates.length >= 5, `期望 ≥5 条结构候选，实际 ${apiCandidates.length}`)
  for (const candidate of apiCandidates) {
    const evidence = candidate.draft.evidence
    assert.ok(evidence.length > 0, '每条候选都必须带证据')
    assert.equal(evidence[0]?.kind, 'code')
    assert.ok(evidence[0]?.repo !== undefined, '证据应记录仓库别名而不是真实路径')
    assert.ok(evidence[0]?.hint?.includes('处调用') === true, '证据应是抽象描述，不是文件路径')
  }
})

test('P3-④ 没有模型时规则路径仍产出候选', async () => {
  const outcome = await mineRepository({
    view: repoView(FIXTURE),
    stack: JAVA_STACK,
    cache: emptyMineCache(),
    model: '',
    options: {
      maxFiles: 100, maxBytes: 100_000, minOccurrences: 2, maxModelCalls: 0,
      exampleMaxLines: 8, exampleMaxChars: 480, timeoutMs: 10_000,
    },
  })
  assert.equal(outcome.stats.modelCalls, 0)
  assert.ok(outcome.candidates.length > 0, '无模型时功能不得静默失效')
  assert.ok(outcome.candidates.every(candidate => candidate.origin === 'rule'))
})

test('P3-② 产出是总结性知识：无完整实现，示例被压到硬上限并占位符化', async () => {
  const longCode = Array.from({ length: 20 }, (_, index) => `    step${index}();`).join('\n')
  const candidate = {
    origin: 'model' as const,
    source: 'unrelated source text that shares nothing',
    draft: {
      kind: 'procedure' as const,
      name: 'OrderService 的提交流程',
      when: '需要提交订单时',
      summary: '按顺序完成授权与创建，并在此前校验金额。',
      steps: ['授权', '创建'],
      example: { language: 'java', kind: 'usage' as const, code: longCode },
      pitfalls: [],
      verify: [],
      stack: JAVA_STACK,
      tags: [],
      evidence: [],
    },
  }
  const finalized = finalizeCandidate(candidate, {
    identifiers: ['OrderService'],
    exampleMaxLines: 8,
    exampleMaxChars: 480,
  })
  assert.ok('candidate' in finalized, '不应被误判为泄漏')
  const code = finalized.candidate.draft.example?.code ?? ''
  assert.ok(code.split('\n').length <= 8, `示例行数超限：${code.split('\n').length}`)
  assert.ok(code.length <= 480)
  assert.ok(!finalized.candidate.draft.name.includes('OrderService'), '私有标识必须被占位符化')
  assert.match(finalized.candidate.draft.name, /<Class1>/u, '保留种类信息但去掉具体名字')
})

test('P3-③ 泄漏校验拦住逐字抄录与残留私有标识', () => {
  const source = `
public void submit(Order order) {
  OrdersClient.authorize(order.token());
  OrdersClient.create(order);
  if (order.total() < 0) throw new IllegalArgumentException("negative total");
}
`
  const copied = leakCheck(
    'public void submit(Order order) { OrdersClient.authorize(order.token()); OrdersClient.create(order); if (order.total() < 0) throw new IllegalArgumentException',
    source,
    [],
  )
  assert.ok(copied.verbatimRuns.length > 0, '逐字长片段必须被识别为泄漏')
  assert.equal(leakCheck('先授权再创建订单，并在创建前校验金额非负。', source, []).verbatimRuns.length, 0)
  assert.deepEqual(leakCheck('用 OrderService 处理提交', source, ['OrderService']).identifierHits, ['OrderService'])
})

test('P3-③b 模型逐字抄录来源时该候选被拒绝入库', async () => {
  // 逐字抄录必须抄**模型实际收到的那段摘录**，否则测的不是同一件事。
  const copying = async (_system: string, user: string): Promise<string> => {
    const match = /"excerpt":"((?:[^"\\]|\\.)*)"/u.exec(user)
    const excerpt = match === null ? '' : JSON.parse(`"${match[1] as string}"`) as string
    return JSON.stringify({
      techniques: [{
        kind: 'procedure',
        name: '提交流程',
        when: '提交订单时',
        summary: excerpt.slice(0, 400),
        example: { language: 'java', kind: 'usage', code: excerpt.slice(0, 300) },
        tags: [],
      }],
    })
  }
  const outcome = await mineRepository({
    view: repoView(FIXTURE),
    stack: JAVA_STACK,
    cache: emptyMineCache(),
    model: 'fake',
    call: copying,
    options: {
      maxFiles: 100, maxBytes: 100_000, minOccurrences: 2, maxModelCalls: 3,
      exampleMaxLines: 8, exampleMaxChars: 480, timeoutMs: 10_000,
    },
  })
  assert.ok(outcome.rejected.length > 0, '逐字抄录的候选必须被拒绝')
  assert.match(outcome.rejected[0]?.reason ?? '', /逐字重合/u)
  assert.ok(
    outcome.candidates.every(candidate => candidate.origin === 'rule'),
    '通过的只应是规则候选',
  )
})

test('P3-⑤ 二次挖掘跳过未变文件，文件变化后重新处理', async () => {
  const view = repoView(FIXTURE)
  const options = {
    maxFiles: 100, maxBytes: 100_000, minOccurrences: 2, maxModelCalls: 0,
    exampleMaxLines: 8, exampleMaxChars: 480, timeoutMs: 10_000,
  }
  const first = await mineRepository({ view, stack: JAVA_STACK, cache: emptyMineCache(), model: '', options })
  assert.ok(first.processed.length > 0)
  assert.equal(first.stats.skippedCached, 0)

  const cache = withCacheEntries(emptyMineCache(), first.processed, '')
  const second = await mineRepository({ view, stack: JAVA_STACK, cache, model: '', options })
  assert.equal(second.stats.skippedCached, first.processed.length, '未变文件应全部命中缓存')
  assert.equal(second.processed.length, 0)

  // 改一个文件后，只有它被重新处理。
  const changed = { ...FIXTURE }
  const target = 'src/app/handler.ts'
  changed[target] = `${FIXTURE[target] as string}\n// touched\n`
  const third = await mineRepository({
    view: repoView(changed), stack: JAVA_STACK, cache, model: '', options,
  })
  assert.deepEqual(third.processed.map(file => file.path), [target])

  // 模型标识变化同样应导致重挖（提示/模型不同，产出可能不同）。
  assert.equal(cacheHit(cache, target, changed[target] as string, 'other-model'), false)
  assert.equal(contentHash('a'), contentHash('a'))
  assert.notEqual(contentHash('a'), contentHash('b'))
})

test('规则候选只陈述结构事实，不臆造语义', () => {
  const file: ScannedFile = {
    path: 'src/app/handler.ts', role: 'service-layer', language: 'typescript',
    content: FIXTURE['src/app/handler.ts'] as string,
  }
  const facts = [analyzeSource(file)]
  const cluster = clusterSymbols(facts, 2).find(item => item.symbol === 'client.send')
  assert.ok(cluster !== undefined)
  const candidate = ruleCandidate(cluster, JAVA_STACK, '/fake-repo')
  assert.equal(candidate.draft.kind, 'api-usage')
  assert.match(candidate.draft.summary, /结构化观察/u, '规则路径必须声明自己只是结构观察')
  assert.deepEqual(candidate.draft.pitfalls, [], '规则路径不臆造坑')
  assert.equal(candidate.draft.example, undefined, '规则路径不产出代码')
  assert.equal(candidate.draft.api?.[0]?.symbol, 'client.send')
  assert.ok(wordSequence(candidate.source).length > 0, '候选需携带来源文本供泄漏校验')
})
