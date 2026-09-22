/**
 * 配置层测试：用真实的 schemastery 校验 `Config`，确认默认值补齐与非法值拒绝。
 *
 * @module dsh-memory-layer/test/config.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  LAYER_SCOPE_DEFAULTS,
  MEMORY_DIR_NAME,
  PROMPT_SECTION_NAME,
  TECHNIQUE_SECTION_NAME,
  resolveDir,
  resolveSkillDir,
  DSH_HOME_ENV,
} from '../src/index.js'

test('空配置被补全为可用的默认值', () => {
  const parsed = Config({})
  // `scope` 刻意没有默认值：缺省时按层取 LAYER_SCOPE_DEFAULTS（见下一条用例）。
  assert.equal(parsed.scope, undefined)
  assert.equal(parsed.injectPrompt, true)
  assert.equal(parsed.registerTools, true)
  assert.equal(parsed.distillOnTurnEnd, true)
  assert.equal(parsed.recallLimit, 5)
  assert.equal(parsed.recallChars, 4000)
  assert.equal(parsed.promptOrder, 250)
  assert.equal(parsed.distillTimeoutMs, 30_000)
  assert.equal(parsed.dir, undefined)
  assert.equal(parsed.provider, undefined)
  assert.equal(parsed.techniques, true)
  assert.equal(parsed.techniqueLimit, 3)
  assert.equal(parsed.techniqueChars, 3000)
  assert.equal(parsed.techniquePromptOrder, 260)
  assert.equal(parsed.exampleMaxLines, 8)
  assert.equal(parsed.exampleMaxChars, 480)
  assert.equal(parsed.allowConfidentialGlobal, false)
  assert.equal(parsed.reflectOnSessionEnd, true)
  assert.equal(parsed.reflectMinTurns, 3)
  assert.equal(parsed.reflectNoveltyThreshold, 0.15)
  assert.equal(parsed.reflectBackoffAfterEmpty, 5)
  assert.equal(parsed.partition, 'default')
})

test('按层默认作用域：episodic 留在项目域，其余全局', () => {
  assert.deepEqual(LAYER_SCOPE_DEFAULTS, {
    episodic: 'project',
    semantic: 'global',
    technique: 'global',
    failure: 'global',
  })
})

test('layerScopes 可逐层覆盖，且非法值被拒绝', () => {
  const parsed = Config({ layerScopes: { technique: 'project' } })
  assert.equal(parsed.layerScopes?.technique, 'project')
  assert.equal(parsed.layerScopes?.episodic, undefined)
  assert.throws(() => Config({ layerScopes: { technique: 'nonsense' } } as never))
})

test('合法的显式配置被原样保留', () => {
  const parsed = Config({
    scope: 'global',
    recallLimit: 12,
    injectPrompt: false,
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  assert.equal(parsed.scope, 'global')
  assert.equal(parsed.recallLimit, 12)
  assert.equal(parsed.injectPrompt, false)
  assert.equal(parsed.provider, 'deepseek')
  assert.equal(parsed.model, 'deepseek-chat')
})

test('非法枚举值被拒绝', () => {
  assert.throws(() => Config({ scope: 'nonsense' } as never))
})

test('越界数值被拒绝', () => {
  assert.throws(() => Config({ recallLimit: 0 }))
  assert.throws(() => Config({ recallLimit: 999 }))
  assert.throws(() => Config({ recallChars: 10 }))
  assert.throws(() => Config({ distillTimeoutMs: 10 }))
})

test('常量与默认目录解析', () => {
  assert.equal(MEMORY_DIR_NAME, 'memory-layer')
  assert.equal(PROMPT_SECTION_NAME, 'memory-layer:recall')
  assert.equal(TECHNIQUE_SECTION_NAME, 'memory-layer:techniques')
  assert.match(resolveDir(undefined), new RegExp(`${MEMORY_DIR_NAME}$`, 'u'))
  assert.equal(resolveDir('/tmp/explicit-memory'), '/tmp/explicit-memory')
})

test('DSH_HOME 覆盖默认目录', () => {
  const previous = process.env[DSH_HOME_ENV]
  try {
    process.env[DSH_HOME_ENV] = '/tmp/dsh-home-probe'
    assert.equal(resolveDir(undefined), `/tmp/dsh-home-probe/${MEMORY_DIR_NAME}`)
    process.env[DSH_HOME_ENV] = '~/dsh-home-probe'
    assert.match(resolveDir(undefined), new RegExp(`/dsh-home-probe/${MEMORY_DIR_NAME}$`, 'u'))
  } finally {
    if (previous === undefined) delete process.env[DSH_HOME_ENV]
    else process.env[DSH_HOME_ENV] = previous
  }
})

test('YAML 空值（null）在 schema 里原样透传，且解析函数视同未设置', () => {
  // `dir:` 这类空值经 YAML 解析是 null，schemastery 对没有 default 的字段不会把它
  // 变成 undefined —— 这是 rc.2 上把整个 dsh 带崩的根因，必须在解析层消化掉。
  const parsed = Config({ dir: null, keyFile: null, skillExportDir: null } as never)
  assert.equal(parsed.dir, null, 'schemastery 透传 null，插件侧必须自己兜住')

  assert.equal(resolveDir(null), resolveDir(undefined), 'null 目录应回退到默认记忆库')
  assert.equal(resolveSkillDir(null), resolveSkillDir(undefined), 'null 目录应回退到默认 skills 目录')
})
