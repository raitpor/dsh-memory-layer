/**
 * 提炼层测试：模型提炼、规则回退与失败降级。
 *
 * @module dsh-memory-layer/test/distill.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distill, distillWithModel, distillWithRules, isInjectedContext } from '../src/distill.js'
import { HOST_CONTEXT_MARKERS, INJECTION_BLOCKS } from '../src/injection.js'
import type { Transcript } from '../src/distill.js'
import type { LiveTurn } from '../src/types.js'

/** 造一轮对话要点。 */
function turn(overrides: Partial<LiveTurn> = {}): LiveTurn {
  return { turn: 1, user: '', assistant: '', tools: [], files: [], ...overrides }
}

/** 一份典型会话。 */
const transcript: Transcript = {
  cwd: '/work/demo',
  turns: [
    turn({
      user: '我喜欢用 pnpm，不要用 npm。请帮我改一下 src/store.ts。下一步还要补测试。',
      assistant: '好的，我修改了 src/store.ts 并新增了 test/store.test.ts。',
      tools: ['read_file', 'edit_file'],
      files: ['src/store.ts'],
    }),
    turn({ turn: 2, user: '决定就用 JSONL 存情景层。', assistant: '已按 JSONL 落盘。' }),
  ],
}

test('规则提炼抽取偏好、待办与文件', () => {
  const memory = distillWithRules(transcript)
  assert.ok(memory.facts.some(fact => fact.kind === 'preference' && fact.text.includes('pnpm')))
  assert.ok(memory.todos.some(todo => todo.includes('补测试')))
  assert.ok(memory.files.includes('src/store.ts'))
  assert.ok(memory.files.includes('test/store.test.ts'))
  assert.ok(memory.title.includes('pnpm'))
  assert.ok(memory.summary.includes('文件：'))
})

test('规则摘要按「请求 → 过程 → 结果」组织', () => {
  const memory = distillWithRules(transcript)
  assert.ok(memory.summary.includes('请求：我喜欢用 pnpm'), '请求取自首轮用户输入')
  assert.ok(memory.summary.includes('过程：read_file、edit_file'), '过程列出去重后的工具类别')
  assert.ok(memory.summary.includes('结果：已按 JSONL 落盘。'), '结果取自最后一条助手输出')
  // 顺序：请求 → 过程 → 结果。
  assert.ok(
    memory.summary.indexOf('请求：') < memory.summary.indexOf('过程：')
    && memory.summary.indexOf('过程：') < memory.summary.indexOf('结果：'),
  )
})

test('过程只记一次工具，重复调用不重复记账，且不再污染检索标签', () => {
  const memory = distillWithRules({
    turns: [
      turn({ turn: 1, user: '先跑一遍测试。', tools: ['bash', 'read'] }),
      turn({ turn: 2, user: '再跑一遍。', tools: ['bash', 'read', 'edit'] }),
      turn({ turn: 3, user: '继续。', tools: ['bash'] }),
    ],
  })
  assert.ok(memory.summary.includes('过程：bash、read、edit'))
  assert.equal(memory.summary.match(/bash/gu)?.length, 1, '同一工具重复调用只记一次')
  assert.deepEqual(memory.tags, [], '工具名不再作为检索标签')
})

test('检索标签只取技术栈语言并小写', () => {
  const memory = distillWithRules({
    stack: { languages: ['TypeScript', 'TSX'] },
    turns: [turn({ user: '随便聊聊。' })],
  })
  assert.deepEqual(memory.tags, ['typescript', 'tsx'])
})

test('宿主注入块被识别，用户提问不会被误伤', () => {
  // 标记**由块定义派生**（`injection.ts`），所以这里逐块验证：任何一段注入的块首
  // 若不再被识别，整段就会被当成用户原话重新捕获，并随「召回 → 再捕获」循环放大。
  for (const block of INJECTION_BLOCKS) {
    assert.equal(
      isInjectedContext(block.header.join('\n')),
      true,
      `${block.section} 的块首必须能被识别为注入块`,
    )
  }
  for (const marker of HOST_CONTEXT_MARKERS) {
    assert.equal(isInjectedContext(`${marker} This snapshot supersedes earlier snapshots.`), true)
  }
  assert.equal(isInjectedContext(`  \n  ${HOST_CONTEXT_MARKERS[0] as string} …`), true, '前导空白不影响判定')
  assert.equal(isInjectedContext('你刚在另一个会话做了什么'), false)
  assert.equal(isInjectedContext('刚才那段 Recalled memory 是什么意思？'), false, '只匹配开头，不误伤提问')
  assert.equal(isInjectedContext(''), false)
})

test('规则提炼不臆造会话里没有的文件', () => {
  const memory = distillWithRules({ turns: [turn({ user: '随便聊聊天气。' })] })
  assert.deepEqual(memory.files, [])
})

test('规则提炼在空会话上也不抛错', () => {
  const memory = distillWithRules({ turns: [] })
  assert.equal(memory.title, 'untitled session')
  assert.deepEqual(memory.facts, [])
})

test('模型提炼解析 JSON 产物', async () => {
  const memory = await distillWithModel(async () => JSON.stringify({
    title: 'JSONL 存储设计',
    summary: '确定情景层用 JSONL。',
    decisions: ['情景层使用 JSONL'],
    todos: ['补测试'],
    files: ['src/store.ts'],
    tags: ['Storage'],
    facts: [{ kind: 'preference', text: '用户偏好 pnpm。' }],
  }), transcript)

  assert.equal(memory.title, 'JSONL 存储设计')
  assert.deepEqual(memory.decisions, ['情景层使用 JSONL'])
  assert.deepEqual(memory.tags, ['storage'])
  assert.equal(memory.facts.length, 1)
  assert.equal(memory.facts[0]?.kind, 'preference')
})

test('模型输出夹带解释文字时仍能取到 JSON', async () => {
  const memory = await distillWithModel(
    async () => '好的，结果如下：\n```json\n{"title":"t","summary":"s"}\n```\n希望有帮助。',
    transcript,
  )
  assert.equal(memory.title, 't')
})

test('模型给出未知 kind 时归为 fact', async () => {
  const memory = await distillWithModel(
    async () => JSON.stringify({ title: 't', facts: [{ kind: 'nonsense', text: '事实' }] }),
    transcript,
  )
  assert.equal(memory.facts[0]?.kind, 'fact')
})

test('模型输出不是 JSON 时抛错，交给上层回退', async () => {
  await assert.rejects(() => distillWithModel(async () => 'no json here', transcript), /no JSON object/u)
})

test('未配置模型时 distill 直接走规则路径', async () => {
  const result = await distill(transcript, {})
  assert.equal(result.source, 'rule')
  assert.equal(result.fallbackReason, 'no model route configured')
})

test('模型失败时 distill 回退规则并带上失败原因', async () => {
  const result = await distill(transcript, {
    call: async () => {
      throw new Error('provider exploded')
    },
  })
  assert.equal(result.source, 'rule')
  assert.match(result.fallbackReason ?? '', /provider exploded/u)
  assert.ok(result.memory.facts.some(fact => fact.text.includes('pnpm')))
})

test('模型超时也会回退规则', async () => {
  const result = await distill(transcript, {
    call: async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return '{}'
    },
    timeoutMs: 20,
  })
  assert.equal(result.source, 'rule')
  assert.match(result.fallbackReason ?? '', /timeout|abort/iu)
})
