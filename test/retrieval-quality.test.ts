/**
 * 检索质量回归：用**带标签的合成语料**测排序与「一次查询的 facet 覆盖」。
 *
 * 为什么要有这个文件：所有检索改动（字段权重、查询扩展、facet 合并、换索引后端）
 * 都必须先能证伪。真实记忆库不进仓库（含私有路径与原话），所以这里用一套虚构的内部库
 * 语料 + 人工标注的期望集合，测试完全确定、可在 CI 跑。
 *
 * 两条断言刻意并存：
 *   1. `单查询在多 facet 任务上必然漏` —— 把**已知缺陷**钉住，谁改好了它就必须改这条断言，
 *      不能悄悄"顺手把它改绿"；
 *   2. `facet 召回能覆盖全部 facet` —— 这才是验收标准。
 *
 * @module dsh-memory-layer/test/retrieval-quality
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { facetQueries, recallDocsFacets, recallFacets, recallTechniques, toTechniqueDocs } from '../src/recall.js'
import type { StackProfile, TechniqueKind, TechniqueRecord } from '../src/types.js'

const STACK: StackProfile = { languages: ['java'], frameworks: ['spring-boot'] }

/** 造一条技巧记录（只关心检索相关字段）。 */
function tech(id: string, kind: TechniqueKind, name: string, when: string, summary: string, tags: string[], api: string[] = []): TechniqueRecord {
  return {
    id,
    ts: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    scope: 'global',
    partition: 'default',
    kind,
    status: 'validated',
    sensitivity: 'internal',
    name,
    when,
    summary,
    ...(api.length === 0 ? {} : { api: api.map(symbol => ({ symbol })) }),
    pitfalls: [],
    verify: [],
    stack: STACK,
    tags,
    evidence: [],
    deidentified: true,
    hits: 1,
    applied: 0,
    successes: 0,
    failures: 0,
    provenance: 'human',
  }
}

/**
 * 虚构的内部结算库语料：四个 facet 各自至少一条，且**词面互不重叠**（这是现实里最难的情形：
 * 同一领域的知识按主题分散，单查询只能命中一个主题）。
 */
const CORPUS: TechniqueRecord[] = [
  // facet 1：业务规则 / 逻辑
  tech('tq_logic_discount', 'business-rule',
    '折扣计算必须先算等级折扣再叠加活动折扣',
    '新增或修改折扣类型时',
    'DiscountCalculator 先按会员等级取折扣率，再扣减活动折扣；两步顺序不可交换，交换会让活动折扣也被等级折扣放大。',
    ['discount', 'rule'], ['DiscountCalculator.resolve']),
  tech('tq_logic_state', 'business-rule',
    '订单状态机只允许 created→paid→shipped→closed',
    '改动订单状态流转或新增状态时',
    '状态流转集中在 OrderStateMachine.transition，非法流转抛 IllegalStateException 而不是静默忽略；新增状态必须同时补 transition 表与事件。',
    ['order', 'state'], ['OrderStateMachine.transition']),
  // facet 2：流程 / 怎么加新业务
  tech('tq_proc_newcase', 'procedure',
    '新增一种业务分支要同时改四处',
    '给结算流程加一种新的业务分支时',
    '加分支的固定动作：枚举加值、策略表注册、事件订阅、结算用例补测试。漏掉策略表注册会走进 default 分支而不报错。',
    ['procedure', 'settlement']),
  // facet 3：测试 / 环境
  tech('tq_env_test', 'env-recipe',
    '结算模块的测试要带 -Dsettlement.mode=shadow 才跑得过',
    '跑结算相关测试或加新测试用例时',
    '本地跑结算测试必须加 JVM 参数 -Dsettlement.mode=shadow，否则会连真实清算服务并在 30 秒超时。',
    ['testing', 'env']),
  // facet 4：输出 / 文档图
  tech('tq_doc_diagram', 'procedure',
    '流程变更要同步更新流程图与接口文档',
    '改动业务流程后补文档时',
    '流程图在 docs/flow/*.puml，改完用 plantuml -checkonly 校验并重新渲染 PNG；接口文档由注解生成，不要手改。',
    ['documentation', 'diagram']),
  // ---- 干扰项：刻意与任务描述**共享更多词面**，但并不是要做的事 ----
  // 没有这批干扰项，合成语料会比真实语料容易得多（作者写语料时天然复用自己查询里的词），
  // 单查询就能凑齐四个 facet，测试随即失去判别力。真实语料里同领域的记录成百上千，
  // top-5 会被"最像"的那些填满 —— 这批干扰项就是在复现那个压强。
  tech('tq_noise_enum', 'procedure',
    '新增折扣类型时同步更新前端下拉枚举',
    '新增折扣类型时',
    '折扣类型枚举在前端有一份镜像，新增后要同步 typings 与下拉选项，否则界面选不到新类型。',
    ['discount', 'frontend']),
  tech('tq_noise_precision', 'pitfall',
    '折扣计算必须用 BigDecimal 不能用 double',
    '实现或修改折扣计算时',
    '折扣率相乘用 double 会在第三位小数上出现偏差，必须用 BigDecimal 并按 HALF_UP 保留两位。',
    ['discount', 'precision']),
  tech('tq_noise_trace', 'procedure',
    '结算流程的日志要带 traceId',
    '给结算流程加日志时',
    '结算相关的日志统一从 SettlementContext 取 traceId，便于按订单串起整条链路。',
    ['settlement', 'logging']),
  tech('tq_noise_png', 'env-recipe',
    '流程图渲染 PNG 时要显式指定 charset',
    '渲染含中文的流程图时',
    'plantuml 渲染含中文的图要加 -charset UTF-8，否则标签变成问号。',
    ['documentation', 'charset']),
  tech('tq_noise_shadow', 'procedure',
    '测试环境 shadow 模式的注意事项',
    '在测试环境验证结算链路时',
    'shadow 模式下真实清算被旁路，断言要针对旁路记录而不是外部返回值。',
    ['testing', 'shadow']),
  tech('tq_noise_batch', 'procedure',
    '结算批处理只在时间窗口内跑',
    '调整结算批处理调度时',
    '批处理窗口是每天 02:00-04:00，窗口外触发会被调度器丢弃且只记 debug 日志。',
    ['settlement', 'batch']),
  // 干扰项：同领域但不同主题（用来验证排序不会被邻域词拉偏）
  tech('tq_noise_refund', 'api-usage',
    '退款接口 RefundClient.reverse 必须带幂等键',
    '调用退款接口时',
    'RefundClient.reverse(orderId, idempotencyKey) 的第二个参数必填，缺失会返回 409 而不是抛错。',
    ['refund'], ['RefundClient.reverse']),
  tech('tq_noise_cache', 'pitfall',
    '结算结果缓存不能跨租户复用',
    '给结算结果加缓存时',
    '缓存键必须含 tenantId；只按 orderId 做键会在多租户下串号，且不会立刻报错。',
    ['cache', 'tenant']),
  tech('tq_noise_mq', 'procedure',
    '结算完成事件用 Kafka 而不是同步回调',
    '通知下游结算完成时',
    '结算完成发 settlement.completed 到 Kafka，消费者侧自行幂等；不要加同步回调，会拖长事务。',
    ['kafka', 'event']),
]

const DOCS = toTechniqueDocs(CORPUS)

/** 单条查询的排名位置（1 起；未召回为 0）。 */
function rankOf(ids: readonly string[], expected: string): number {
  return ids.findIndex(id => id === expected) + 1
}

/** 一批查询的汇总指标。 */
function evaluate(run: (query: string) => string[], cases: readonly { query: string; expect: readonly string[] }[]) {
  let hit1 = 0, hit3 = 0, mrr = 0, missingTotal = 0, expectedTotal = 0
  for (const { query, expect } of cases) {
    const ids = run(query)
    const ranks = expect.map(id => rankOf(ids, id))
    const found = ranks.filter(rank => rank > 0)
    const best = found.length > 0 ? Math.min(...found) : 0
    if (best === 1) hit1 += 1
    if (best > 0 && best <= 3) hit3 += 1
    if (best > 0) mrr += 1 / best
    missingTotal += ranks.length - found.length
    expectedTotal += expect.length
  }
  return { hit1, hit3, mrr: mrr / cases.length, missingTotal, expectedTotal, total: cases.length }
}

/** 单意图查询：查询词与目标记录同主题，词面部分重叠。 */
const SINGLE_FACET = [
  { query: '折扣和活动折扣的先后顺序', expect: ['tq_logic_discount'] },
  { query: '订单状态怎么流转，能不能跳过 shipped', expect: ['tq_logic_state'] },
  { query: '跑结算测试总是超时', expect: ['tq_env_test'] },
  { query: '退款接口报 409', expect: ['tq_noise_refund'] },
  { query: '缓存串号了', expect: ['tq_noise_cache'] },
  { query: '改完流程要更新什么文档', expect: ['tq_doc_diagram'] },
]

/** 多 facet 任务：一句话里同时含四个主题，期望四条都被召回。 */
const MULTI_FACET = {
  query: '新增一种折扣类型，走完整结算流程，最后补流程图和测试',
  expect: ['tq_logic_discount', 'tq_proc_newcase', 'tq_doc_diagram', 'tq_env_test'],
}

test('检索基线：单意图查询的排序质量（现状必须达标）', () => {
  const run = (query: string) => recallTechniques(query, DOCS, { limit: 3, includeDrafts: true, stack: STACK })
    .map(hit => hit.id)
  const stats = evaluate(run, SINGLE_FACET)
  assert.equal(stats.hit1, SINGLE_FACET.length, `每个单意图查询都应排第 1：${stats.hit1}/${SINGLE_FACET.length}`)
  assert.equal(stats.mrr, 1, 'MRR 应为 1')
})

test('已知缺陷：单查询在多 facet 任务上必然漏（钉住它，别顺手改绿）', () => {
  const ids = recallTechniques(MULTI_FACET.query, DOCS, { limit: 5, includeDrafts: true, stack: STACK })
    .map(hit => hit.id)
  const missing = MULTI_FACET.expect.filter(id => !ids.includes(id))
  // 这条断言守的是**夹具的判别力**：如果单查询就能覆盖四个 facet，说明干扰项不够强，
  // 此时该补强干扰项（让语料更像真实库），而不是把断言删掉或改绿。
  assert.ok(
    missing.length > 0,
    `合成语料失去了判别力：单查询居然覆盖了全部 facet（实际 ${ids.join(', ')}）。请补强干扰项。`,
  )
})

test('facet 切分：从任务描述里抽出多个子查询（无模型）', () => {
  const facets = facetQueries(MULTI_FACET.query, DOCS)
  assert.ok(facets.length >= 2, `应切出多个 facet，实际 ${JSON.stringify(facets)}`)
  // 至少覆盖到「折扣 / 图 / 测试」三类主题词之一以上
  const joined = facets.join(' ')
  assert.ok(/折扣/u.test(joined), `应含折扣 facet：${joined}`)
  assert.ok(/图/u.test(joined), `应含流程图 facet：${joined}`)
})

/**
 * 主题分组：任务型查询要的是「每个主题都有代表」，而不是「必须是某一条」。
 * 组内哪条胜出是精度问题，不该由测试钦定具体 id —— 那会逼着实现去迎合标注者的措辞。
 */
const FACET_GROUPS: Record<string, string[]> = {
  折扣: ['tq_logic_discount', 'tq_noise_enum', 'tq_noise_precision'],
  流程: ['tq_proc_newcase', 'tq_noise_trace', 'tq_noise_batch'],
  文档图: ['tq_doc_diagram', 'tq_noise_png'],
  测试: ['tq_env_test', 'tq_noise_shadow'],
}

/** 结果覆盖了几个主题。 */
function coveredGroups(ids: readonly string[]): string[] {
  return Object.entries(FACET_GROUPS)
    .filter(([, members]) => members.some(id => ids.includes(id)))
    .map(([name]) => name)
}

test('facet 召回：一句话覆盖全部四个主题', () => {
  const facets = facetQueries(MULTI_FACET.query, DOCS)
  const perFacet = facets.map(facet => `${facet}→[${recallTechniques(facet, DOCS, { limit: 2, includeDrafts: true, stack: STACK }).map(h => h.id).join(',')}]`)
  const ids = recallFacets(MULTI_FACET.query, DOCS, { limit: 5, stack: STACK }).map(hit => hit.id)
  const covered = coveredGroups(ids)
  assert.deepEqual(
    covered.sort(),
    Object.keys(FACET_GROUPS).sort(),
    `四个主题都要有代表：覆盖了 ${covered.join('/') || '无'}，实际召回 ${ids.join(', ')}\n  各 facet 前二：${perFacet.join(' ')}`,
  )
})

test('facet 召回的主题覆盖优于单查询（这条差值就是收益）', () => {
  const single = coveredGroups(
    recallTechniques(MULTI_FACET.query, DOCS, { limit: 5, includeDrafts: true, stack: STACK }).map(hit => hit.id),
  )
  const faceted = coveredGroups(
    recallFacets(MULTI_FACET.query, DOCS, { limit: 5, stack: STACK }).map(hit => hit.id),
  )
  assert.ok(
    faceted.length > single.length,
    `facet 召回应覆盖更多主题：单查询 ${single.length} 个（${single.join('/')}）vs facet ${faceted.length} 个（${faceted.join('/')}）`,
  )
})

test('facet 召回不得把无关主题硬拉进来（负例控制）', () => {
  // 语料里没有 Kubernetes 相关的任何东西：不应出现"自信的误召回"。
  const ids = recallFacets('Kubernetes 集群怎么部署', DOCS, { limit: 3, stack: STACK }).map(hit => hit.id)
  assert.ok(
    !ids.includes('tq_logic_discount') && !ids.includes('tq_logic_state'),
    `无关查询不应召回核心业务规则：${ids.join(', ')}`,
  )
})

test('facet 召回的条数与去重：同一记录只出现一次', () => {
  const hits = recallFacets(MULTI_FACET.query, DOCS, { limit: 10, stack: STACK })
  assert.equal(new Set(hits.map(hit => hit.id)).size, hits.length, '合并后不得重复')
  assert.ok(hits.length <= 10, '不得超过 limit')
})

test('facet 化不得丢掉空查询语义：空查询退化为最近记忆', () => {
  // 空查询时 `recallTechniques` 会按时间给所有候选一个基础分；facet 切分若把它丢掉，
  // 注入就变成"什么都不给" —— 这是既有语义，必须保留。
  const facets = facetQueries('', DOCS)
  assert.deepEqual(facets, [''], '空查询的 facet 列表就是它自己')
  const hits = recallFacets('', DOCS, { limit: 3, stack: STACK })
  assert.equal(hits.length, 3, '空查询应退回"最近记忆"，而不是空结果')
})

// ---- B：情景/语义层共用同一套 facet 机制 ------------------------------------

test('facet 机制对任意层生效：情景摘要也能一次覆盖多个主题', () => {
  // 情景/语义文档没有 `meta.tags`，词表帮不上忙，全靠子句切分 —— 这正是要验证的路径。
  const episodic = [
    { layer: 'episodic' as const, id: 'ep_a', ts: 1, text: '会话摘要：修了登录超时的问题。' },
    { layer: 'episodic' as const, id: 'ep_b', ts: 2, text: '会话摘要：调整了导出报表的列顺序。' },
    { layer: 'episodic' as const, id: 'ep_c', ts: 3, text: '会话摘要：重构了缓存淘汰策略。' },
    { layer: 'episodic' as const, id: 'ep_d', ts: 4, text: '会话摘要：加了两个集成测试。' },
  ]
  const hits = recallDocsFacets('登录超时还没修完，顺便看下导出报表，另外测试也要补', episodic, { limit: 3 })
  const ids = hits.map(hit => hit.id)
  assert.ok(ids.includes('ep_a'), `「登录超时」主题应在：${ids.join(', ')}`)
  assert.ok(ids.includes('ep_b'), `「导出报表」主题应在：${ids.join(', ')}`)
  assert.equal(new Set(ids).size, ids.length, '不得重复')
})

test('facet 机制吃结构化补充词：只有文件路径能连上的旧会话也能被召回', () => {
  const episodic = [
    { layer: 'episodic' as const, id: 'ep_x', ts: 1, text: '会话摘要：改过 order-policy 的折扣分支。' },
    { layer: 'episodic' as const, id: 'ep_y', ts: 2, text: '会话摘要：处理了一个无关的构建告警。' },
  ]
  // 查询词与 ep_x 毫无词面重叠，只有 extra 里的文件路径能连上。
  const plain = recallDocsFacets('这个文件为什么这么写', episodic, { limit: 2 }).map(hit => hit.id)
  const withExtra = recallDocsFacets('这个文件为什么这么写', episodic, {
    limit: 2,
    extra: ['src/order/order-policy.ts'],
  }).map(hit => hit.id)
  assert.ok(
    withExtra.includes('ep_x'),
    `带结构化线索时应召回 ep_x：无 extra=${plain.join(',')} 有 extra=${withExtra.join(',')}`,
  )
})
