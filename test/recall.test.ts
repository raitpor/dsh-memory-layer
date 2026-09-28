/**
 * 召回层测试：中英分词、BM25 排序与空查询回退。
 *
 * @module dsh-memory-layer/test/recall.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStandingRule, recall, recallDocsFacets, recallFacets, recallTechniques, toDocs, toTechniqueDocs, tokenize } from '../src/recall.js'
import type { EpisodicRecord, SemanticRecord, TechniqueRecord } from '../src/types.js'

/** 造一条情景记录。 */
function episodic(overrides: Partial<EpisodicRecord> = {}): EpisodicRecord {
  return {
    id: 'ep_1',
    ts: 1_700_000_000_000,
    sessionId: 's1',
    scope: 'project',
    title: '',
    summary: '',
    decisions: [],
    todos: [],
    files: [],
    tags: [],
    source: 'rule',
    ...overrides,
  }
}

/** 造一条语义记录。 */
function semantic(overrides: Partial<SemanticRecord> = {}): SemanticRecord {
  return {
    id: 'sm_1',
    ts: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    scope: 'project',
    kind: 'fact',
    key: 'k',
    text: '',
    hits: 1,
    sources: [],
    tags: [],
    ...overrides,
  }
}

test('中文切成相邻二字 bigram', () => {
  assert.deepEqual(tokenize('跨会话记忆'), ['跨会', '会话', '话记', '记忆'])
})

test('英文按词切分、去停用词、保留数字', () => {
  assert.deepEqual(tokenize('The plugin uses TypeScript 2026'), ['plugin', 'uses', 'typescript', '2026'])
})

test('中英混排各自成 token', () => {
  const tokens = tokenize('使用 pnpm 安装')
  assert.ok(tokens.includes('pnpm'))
  assert.ok(tokens.includes('使用'))
  assert.ok(tokens.includes('安装'))
})

test('相关记忆排在前面', () => {
  const docs = toDocs(
    [
      episodic({ id: 'ep_a', summary: '讨论了数据库索引优化' }),
      episodic({ id: 'ep_b', summary: '用户偏好使用 pnpm 而不是 npm' }),
    ],
    [],
  )
  const hits = recall('pnpm 还是 npm', docs, { limit: 2 })
  assert.equal(hits[0]?.id, 'ep_b')
})

test('语义层在同等命中下优先于情景层', () => {
  const docs = toDocs(
    [episodic({ id: 'ep_a', summary: 'pnpm 配置' })],
    [semantic({ id: 'sm_a', text: 'pnpm 配置' })],
  )
  const hits = recall('pnpm', docs, { limit: 2 })
  assert.equal(hits[0]?.layer, 'semantic')
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0))
})

test('无命中时返回空数组，便于调用方决定不注入', () => {
  const docs = toDocs([episodic({ summary: '数据库索引' })], [])
  assert.deepEqual(recall('量子计算', docs, { limit: 3 }), [])
})

test('空查询退化为最近记忆', () => {
  const docs = toDocs(
    [
      episodic({ id: 'old', ts: 1_000 }),
      episodic({ id: 'new', ts: 9_000 }),
    ],
    [],
  )
  const hits = recall('   ', docs, { limit: 1 })
  assert.equal(hits[0]?.id, 'new')
})

test('limit 为 0 或空库时返回空', () => {
  assert.deepEqual(recall('pnpm', [], { limit: 3 }), [])
  assert.deepEqual(recall('pnpm', toDocs([episodic({ summary: 'pnpm' })], []), { limit: 0 }), [])
})

test('新鲜度加权让更近的记忆在同等命中下得分更高', () => {
  const now = 1_800_000_000_000
  const docs = toDocs(
    [
      episodic({ id: 'stale', summary: 'pnpm 配置', ts: now - 90 * 24 * 3600 * 1000 }),
      episodic({ id: 'fresh', summary: 'pnpm 配置', ts: now }),
    ],
    [],
  )
  const hits = recall('pnpm', docs, { limit: 2, now })
  assert.equal(hits[0]?.id, 'fresh')
})

test('情景文档带出 sessionId，供注入侧挡掉本会话自己的摘要', () => {
  const docs = toDocs([episodic({ id: 'ep_a', sessionId: 's-a' }), episodic({ id: 'ep_b', sessionId: 's-b' })], [])
  assert.equal(docs[0]?.meta?.sessionId, 's-a')
  assert.equal(docs[1]?.meta?.sessionId, 's-b')
  // 语义层没有会话归属，不该凭空造一个。
  const sem = toDocs([], [{ id: 'sm_1', key: 'k', kind: 'fact', text: 't', hits: 1, sources: ['s1'], tags: [], ts: 1, updatedAt: 1, scope: 'global', partition: 'default' }])
  assert.equal(sem[0]?.meta?.sessionId, undefined)
})

test('toDocs 的作用域标记取自调用方给的桶，而不是记录里的 scope 字段', () => {
  // 记录里写着 `global`，但调用方说这批来自项目桶（两个桶是两个目录，桶才是事实来源）：
  // 标记必须听调用方的，否则 `memory_search(scope)` 会按一条冗余字段把结果放错作用域。
  const episodicRecord = episodic({ id: 'ep_p', scope: 'global' })
  const semanticRecord = { id: 'sm_g', key: 'k', kind: 'fact' as const, text: 't', hits: 1, sources: ['s1'], tags: [], ts: 1, updatedAt: 1, scope: 'project' as const, partition: 'default' }
  assert.equal(toDocs([episodicRecord], [], 'project')[0]?.meta?.scope, 'project')
  assert.equal(toDocs([], [semanticRecord], 'global')[0]?.meta?.scope, 'global')
  // 不传作用域时保持原样（老调用方与注入路径不受影响）。
  assert.equal(toDocs([episodicRecord], [])[0]?.meta?.scope, undefined)
})

/** 造一条已验证的技巧记录。 */
function technique(overrides: Partial<TechniqueRecord> = {}): TechniqueRecord {
  return {
    id: 'tq_1',
    ts: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    scope: 'global',
    partition: 'default',
    kind: 'procedure',
    status: 'validated',
    sensitivity: 'internal',
    name: 'name',
    when: 'when',
    summary: 'summary',
    pitfalls: [],
    verify: [],
    stack: { languages: [] },
    tags: [],
    evidence: [],
    deidentified: true,
    hits: 0,
    applied: 1,
    successes: 1,
    failures: 0,
    provenance: 'model',
    ...overrides,
  }
}

test('相关性门槛：只中一个常见词的弱命中被丢掉，命中领域词的保留', () => {
  // 真库实测的不相关轮次都是「四五个词里只中一个」（如「把函数重命名」只共享了 config），
  // 那种命中正是「每轮白白注入 736–1056 字符」的来源。
  const strong = technique({
    id: 'tq_strong',
    name: 'PlantUML 组件图连接方向',
    when: '画组件图时',
    summary: '单横线水平、双横线竖直。',
    domain: 'plantuml',
  })
  const weak = technique({ id: 'tq_weak', name: 'config default', when: 'adding config', summary: 'Give the config option a default.' })
  const docs = toTechniqueDocs([strong, weak])
  const query = 'rename this function for clarity and add a config flag'
  const ids = (hits: readonly { id: string }[]): string[] => hits.map(hit => hit.id)
  const unfiltered = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000 })
  assert.deepEqual(ids(unfiltered), ['tq_weak'], '不设门槛时弱命中照旧返回（老行为）')
  const filtered = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(ids(filtered), [], '只中一个词 → 丢掉')
  // 相关查询不受影响：门槛只做「减法」。
  const onTopic = recallTechniques('PlantUML 组件图连接方向怎么画', docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(ids(onTopic), ['tq_strong'])
})

test('门槛不得用小语料误杀相关命中：分数会随库规模缩水，命中词数不会', () => {
  // 这条是设计动机的回归锁：同一条相关命中在 354 条的库里是 2.47 分（真库 9.28），
  // 在 2 条的库里只有 0.5 分。所以默认门槛**不能**是绝对分数 —— 否则新装的小库
  // 会把所有技巧都判成不相关，技巧层静默失效。
  const docs = toTechniqueDocs([technique({
    id: 'tq_only',
    name: 'PlantUML 组件图连接方向',
    when: '画组件图时',
    summary: '单横线水平、双横线竖直。',
  })])
  const query = 'PlantUML 组件图连接方向怎么画'
  const byMatched = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(byMatched.map(hit => hit.id), ['tq_only'], '命中词数达标 → 保留')
  // 同一份数据、同一条查询，若门槛误设成绝对分数就会一条不剩。
  const byScore = recallTechniques(query, docs, { limit: 5, now: 1_700_000_000_000, gate: { minScore: 4 } })
  assert.deepEqual(byScore, [], '绝对分数门槛在小语料上会把相关命中一起杀掉（故默认关闭）')
})

test('门槛对记忆层同样生效：只共享一个中文常见词的情景摘要不进注入', () => {
  // 记忆与技巧在这一点上是同一个病：BM25 只要共享一个常见词就给分。区别只在
  // 「不相关的那一条」对记忆而言同样是纯噪声 —— 实测里一个不相关的轮次仍注入了
  // 903 字符的记忆条目，而它对本轮任务没有任何信息量。
  //
  // 夹具刻意用**中文二字词**：「缓存」不是标识符，命中一个不足以证明相关；
  // 而 `pnpm`/`authorize` 这类标识符命中一个就算强证据（见 GATE 的强字段规则）。
  const docs = toDocs([episodic({ id: 'ep_weak', summary: '缓存命中率调优', ts: 1_700_000_000_000 })], [])
  const gate = { minMatched: 2 }
  const query = '缓存失效了怎么办'
  assert.equal(recallDocsFacets(query, docs, { limit: 5, now: 1_700_000_000_000 }).length, 1, '不设门槛时照旧返回')
  assert.deepEqual(recallDocsFacets(query, docs, { limit: 5, now: 1_700_000_000_000, gate }), [], '只中一个常见词 → 丢掉')
})

test('isStandingRule 只认语义层的偏好与约束', () => {
  // 这个判定只服务于注入路径（常驻规则从检索语料里摘出来单独直取），因此它属于召回层：
  // 谁是常驻规则由一个地方说了算。事实与决定是「关于某件事的陈述」，只在相关时才有价值。
  const docs = toDocs([episodic({ id: 'ep_1', summary: 's' })], [
    semantic({ id: 'sm_p', kind: 'preference', text: 't' }),
    semantic({ id: 'sm_c', kind: 'constraint', text: 't' }),
    semantic({ id: 'sm_f', kind: 'fact', text: 't' }),
    semantic({ id: 'sm_d', kind: 'decision', text: 't' }),
  ])
  const standing = docs.filter(doc => isStandingRule(doc)).map(doc => doc.id)
  assert.deepEqual(standing, ['sm_p', 'sm_c'])
})

test('门槛只作用于自动注入：显式检索（不传 gate）行为完全不变', () => {
  const weak = technique({ id: 'tq_w', name: 'config default', when: 'adding config', summary: 'Give the config option a default.' })
  const docs = toTechniqueDocs([weak])
  const gated = recallFacets('add a config flag', docs, { limit: 3, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(gated, [], '注入路径上被门槛丢掉')
  // 工具显式检索走的就是这条（不传 gate）：模型主动要的东西一条不少。
  const explicit = recallFacets('add a config flag', docs, { limit: 3, now: 1_700_000_000_000 })
  assert.deepEqual(explicit.map(hit => hit.id), ['tq_w'])
})

test('短查询自动放宽：非通用词只有一两个时，只中一个也算相关', () => {
  // `PlantUML 中文` 这种两词查询里，`中文` 是通用词、「plantuml」是全部线索；
  // 按 2 硬卡会误杀 —— 这正是「放宽只看非通用词个数」要保住的一类查询。
  const docs = toTechniqueDocs([technique({
    id: 'tq_cjk',
    name: 'PlantUML CJK 图渲染',
    when: '中文乱码时',
    summary: '显式指定 -charset UTF-8。',
  })])
  const hits = recallTechniques('PlantUML 中文', docs, { limit: 5, now: 1_700_000_000_000, gate: { minMatched: 2 } })
  assert.deepEqual(hits.map(hit => hit.id), ['tq_cjk'])
})

test('短查询放宽：非通用词只有两个时，只中一个也放行', () => {
  // 放宽规则本身要单独锁住：`PlantUML 中文` 那条用例其实是被「标识符算强证据」救下的，
  // 即使把放宽去掉也照样通过，测不到规则。这里用中文非通用词，且查询只有两个非通用词。
  const docs = toDocs([episodic({ id: 'ep_gate', summary: '缓存命中率调优', ts: 1_700_000_000_000 })], [])
  const gate = { minMatched: 2 }
  const hits = recallDocsFacets('缓存 超时', docs, { limit: 5, now: 1_700_000_000_000, gate })
  assert.deepEqual(hits.map(hit => hit.id), ['ep_gate'], '两个非通用词里中一个 → 放宽后放行')
})

test('门槛忽略通用词：实测的误放行全部拦下，实测的真命中全部保留', () => {
  // 这批查询与预期来自真库复算（`.verify/measure/why-injected.mjs`、`gate-stopwords.mjs`）。
  // 造一份与真库同形的语料：一条 PlantUML CJK 技巧（含「中文/输出/渲染」）、一条序列图
  // note 技巧、一条插件技巧（含「技巧/库里/dsh」）、一条情景摘要。
  const docs = [
    ...toTechniqueDocs([
      technique({
        id: 'tq_cjk',
        name: '读写 CJK 图时显式指定 -charset UTF-8',
        when: '中文标签渲染成问号时',
        summary: '批量渲染含中文的 .puml 时，输出出现乱码就是编码没对齐。',
        domain: 'plantuml',
        tags: ['plantuml', 'charset'],
      }),
      technique({
        id: 'tq_note',
        name: '序列图 note 的三种锚定语义',
        when: 'note 挂在消息上还是参与者上',
        summary: 'note 可以挂在消息、参与者或横跨两者。',
        tags: ['plantuml', 'sequence-diagram', 'note'],
      }),
      technique({
        id: 'tq_save',
        name: '改已入库技巧的正文',
        when: '发现库里出现同名近重复条目时',
        summary: '用 technique_save 按 id 就地更新，只替换显式给出的字段。',
        tags: ['dsh-memory-layer', 'technique'],
      }),
    ]),
    ...toDocs([episodic({ id: 'ep_timeout', summary: '订单服务的超时配置是 3 秒。', ts: 1_700_000_000_000 })], []),
  ]
  const gate = { minMatched: 2 }
  const injected = (query: string): string[] =>
    recallFacets(query, docs, { limit: 5, now: 1_700_000_000_000, gate }).map(hit => hit.id)

  // 应拦下：全靠通用词过关（输出+中文 / 技巧+库里 / 发现+技巧+给出 / 在一+uml）。
  for (const query of [
    '输出文档应是中文文档',
    '继续，你可以参考一下技巧库里的知识',
    '我在一个 mc 模组移植会话中发现上下文仍有 uml 技巧注入，请定位问题并给出方案',
    '把这个函数重命名成更清晰的名字',
    '开始移植',
  ]) {
    assert.deepEqual(injected(query), [], `不相关的轮次不得注入：${query}`)
  }
  // 应保留：命中领域词 / 标识符 / 多个非通用词。断言「含哪几条」而不是「只有哪几条」——
  // 同一领域下多条技巧同时命中是正常的（它们都真的相关）。
  const contains = (query: string, id: string): void => {
    assert.ok(injected(query).includes(id), `相关查询必须命中 ${id}：${query}`)
  }
  contains('PlantUML 渲染出来的中文是问号', 'tq_cjk')
  contains('时序图里 note 挂在参与者上还是消息上', 'tq_note')
  contains('note 锚定', 'tq_note')
  // 记忆条目走的是召回段那条路径（`recallDocsFacets`）：`recallFacets` 是技巧层专用，
  // 会把非技巧文档整体滤掉 —— 用错函数会让这条断言永远为假。
  assert.ok(
    recallDocsFacets('订单服务的超时是多少', docs, { limit: 5, now: 1_700_000_000_000, gate })
      .map(hit => hit.id)
      .includes('ep_timeout'),
    '相关记忆仍要注入',
  )
})

test('门槛只认用户原话：当轮文件路径/工具名不得替用户表达意图', () => {
  // 实测漏洞：`facetQueries` 会把 extra（当轮文件路径与工具名）按 `/` 切成独立子查询，
  // 而子查询 ≤2 个词时门槛放宽到 1 —— 于是 `docs/architecture.puml` 只靠 `puml`
  // 就能在「开始移植」这一轮放行整套 PlantUML 技巧。排序可以用 extra，判定不行。
  const docs = toTechniqueDocs([technique({
    id: 'tq_cjk',
    name: '读写 CJK 图时显式指定 -charset UTF-8',
    when: '中文乱码时',
    summary: '批量渲染 .puml 时输出乱码就是编码没对齐。',
  })])
  const gate = { minMatched: 2 }
  const extra = ['docs/architecture.puml', 'PORTING-STATUS.md', 'write', 'present']
  assert.deepEqual(
    recallFacets('开始移植', docs, { limit: 5, now: 1_700_000_000_000, extra, gate }).map(hit => hit.id),
    [],
    '路径里的 puml 不得放行',
  )
  // 同一条技巧：用户自己说出 puml 时应当命中（确认不是把这条技巧整个筛掉了）。
  assert.deepEqual(
    recallFacets('puml 乱码', docs, { limit: 5, now: 1_700_000_000_000, extra, gate }).map(hit => hit.id),
    ['tq_cjk'],
  )
})

test('名次分支（sqlite scorer）同样要过门槛', () => {
  // 索引后端的分数是名次派生的、跨后端不可比，但**相关性判据与后端无关**：
  // 否则一开 sqlite 就等于把门槛整段关掉。
  const docs = toTechniqueDocs([technique({
    id: 'tq_mc',
    name: '模组移植要用 NeoForge',
    when: '把模组迁到 1.21.1 时',
    summary: '先判定起点加载器再动手。',
  })])
  const scorer = (): string[] => ['tq_mc']
  const gate = { minMatched: 2 }
  assert.deepEqual(
    recallFacets('输出文档应是中文文档', docs, { limit: 5, now: 1_700_000_000_000, gate, scorer }).map(hit => hit.id),
    [],
    '名次分支也要拦下不相关',
  )
  assert.deepEqual(
    recallFacets('模组移植到 1.21.1', docs, { limit: 5, now: 1_700_000_000_000, gate, scorer }).map(hit => hit.id),
    ['tq_mc'],
    '相关查询在名次分支照旧放行',
  )
})

test('门槛上报每个候选的判定依据（可观测性）', () => {
  // 拦下的东西在上下文里没有痕迹，因此必须能从外面看见「为什么拦下」。
  const docs = toTechniqueDocs([
    technique({ id: 'tq_keep', name: 'note 锚定语义', when: 'note 挂哪里', summary: '挂在消息或参与者上。' }),
    technique({ id: 'tq_drop', name: '输出中文文档', when: '交付文档时', summary: '用中文写文档，输出前检查。' }),
  ])
  const seen: { id: string; kept: boolean; matched: number; generic: number }[] = []
  // 查询里两类词都有：`note`/`锚定` 是实词，`输出/文档/中文` 是通用词 —— 被拦下的那条
  // 只共享通用词，所以它会有 score>0（进得来打分）却过不了门槛（正是要上报的场景）。
  recallFacets('把 note 锚定的输出文档写成中文', docs, {
    limit: 5,
    now: 1_700_000_000_000,
    gate: { minMatched: 2 },
    onDecision: decision => seen.push({
      id: decision.id,
      kept: decision.kept,
      matched: decision.matched,
      generic: decision.generic,
    }),
  })
  const kept = seen.filter(item => item.kept)
  const dropped = seen.filter(item => !item.kept)
  assert.deepEqual(kept.map(item => item.id), ['tq_keep'])
  assert.deepEqual(dropped.map(item => item.id), ['tq_drop'], '被拦下的也要上报')
  assert.ok(dropped[0]!.generic >= 1, '并说清它是靠通用词命中的')
})

test('空查询的两套语义：注入拒绝、显式检索保留「最近记忆」', () => {
  // 同一条规则在两条路径上语义不同，必须各有用例：检索（`memory_search` 的空查询）是
  // 用户显式发起的，保留「取最近」合理；注入是每请求自动发生的，只能按相关性 ——
  // 实测「重启后第一轮又冒出三条 UML 技巧」正是因为空查询走了「按置信度取前 N 条」。
  const docs = toTechniqueDocs([
    technique({ id: 'tq_a', name: '第一条技巧', when: 'a', summary: 'a' }),
    technique({ id: 'tq_b', name: '第二条技巧', when: 'b', summary: 'b' }),
    technique({ id: 'tq_c', name: '第三条技巧', when: 'c', summary: 'c' }),
  ])
  assert.deepEqual(
    recallFacets('', docs, { limit: 3, gate: { minMatched: 2, emptyQuery: 'deny' } }),
    [],
    '注入：空查询不注入',
  )
  assert.equal(
    recallFacets('', docs, { limit: 3, gate: { minMatched: 2, emptyQuery: 'allow' } }).length,
    3,
    '检索：空查询退回最近记忆',
  )
})
