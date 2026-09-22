/**
 * 真实 Cordis 框架冒烟测试：确认插件模块的 `name` / `inject` / `Config` / `apply`
 * 四个导出能被真正的 Cordis 运行时识别并加载，且服务解析与 effect 注册都生效。
 *
 * 前面的 `plugin.test.ts` 用替身 context 覆盖业务链路；这里专门覆盖「框架契约」，
 * 防止写法漂移（例如 `inject` 名字写错、`Config` 不被识别）导致插件静默 PENDING。
 *
 * @module dsh-memory-layer/test/cordis.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply, inject, name } from '../src/index.js'

/** 等待 Cordis 完成一次（异步）插件加载。 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100))
}

/**
 * 把插件对象挂到真实 context 上。
 *
 * Cordis 的 `plugin()` 重载对「模块对象 + config」这一组合的类型推断很窄，
 * 这里显式声明调用形状，避免测试被无关的类型摩擦卡住。
 *
 * @param ctx - 真实 Cordis context。
 * @param config - 传给插件的配置。
 */
function mount(ctx: Context, config: Record<string, unknown>): void {
  const install = ctx.plugin as unknown as (plugin: unknown, config: unknown) => void
  install({ name, inject, Config, apply }, config)
}

test('插件导出满足 Cordis 的插件契约', () => {
  assert.equal(typeof name, 'string')
  assert.ok(name.length > 0)
  assert.deepEqual(inject, ['sessions'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'schemastery schema 应可被框架直接调用')
})

test('真实 Context 能加载插件并完成 system prompt 接线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cordis-'))
  const captured: unknown[] = []
  const ctx = new Context()
  try {
    ctx.provide('sessions', {})
    ctx.provide('systemPrompt', {
      context: (entry: unknown) => {
        captured.push(entry)
        return () => undefined
      },
    })

    mount(ctx, { dir: root })
    await settle()

    assert.equal(captured.length, 3, '插件应已 ACTIVE 并注册 recall / technique / failures 三个 prompt 上下文')
    const entry = captured[0] as { name?: string; order?: number } | undefined
    assert.equal(entry?.name, 'memory-layer:recall')
    assert.equal(entry?.order, 250, '未提供的字段应由 Config schema 补默认值')
    const technique = captured[1] as { name?: string; order?: number } | undefined
    assert.equal(technique?.name, 'memory-layer:techniques')
    assert.equal(technique?.order, 260, '技巧注入 section 排在 recall 之后')
    const failure = captured[2] as { name?: string; order?: number } | undefined
    assert.equal(failure?.name, 'memory-layer:failures')
    assert.equal(failure?.order, 255, '失败预警 section 在 recall 与 techniques 之间')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('systemPrompt / tools 晚于 sessions 上线时，能力仍会被接线（真实 dsh 时序）', async () => {
  // 回归用例：真实 dsh 里 `tools` 服务（ToolRuntime）自身 `inject: ['systemPrompt']`，
  // 因此它上线晚于本插件硬依赖的 `sessions`。旧实现在 apply 里一次性
  // `ctx.get('tools')`，此刻拿到 undefined 且永不重试 —— 14 个工具在正式环境
  // 全部注册不上，而当时所有单测都预先 provide 好服务，复现不了这个时序。
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cordis-'))
  const sections: unknown[] = []
  const registered: string[] = []
  const ctx = new Context()
  try {
    // 阶段一：只有 sessions 就绪，复刻 apply 时刻的真实状态。
    ctx.provide('sessions', {})
    mount(ctx, { dir: root })
    await settle()

    assert.equal(sections.length, 0, '此时 systemPrompt 确实尚未上线')
    assert.equal(registered.length, 0, '此时 tools 确实尚未上线')

    // 阶段二：服务后到，响应式接线必须补上。
    ctx.provide('systemPrompt', {
      context: (entry: unknown) => {
        sections.push(entry)
        return () => undefined
      },
    })
    ctx.provide('tools', {
      register: (definition: { name: string }) => {
        registered.push(definition.name)
        return () => undefined
      },
    })
    await settle()

    assert.equal(sections.length, 3, '晚到的 systemPrompt 仍应装上三个 section')
    assert.equal(registered.length, 14, '晚到的 tools 仍应装上全部 14 个工具')
    for (const expected of ['memory_search', 'memory_save', 'memory_forget', 'memory_stats']) {
      assert.ok(registered.includes(expected), `${expected} 应已注册`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('缺少 sessions 服务时插件停在 PENDING 而不执行 apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cordis-'))
  const captured: unknown[] = []
  const ctx = new Context()
  try {
    ctx.provide('systemPrompt', {
      context: (entry: unknown) => {
        captured.push(entry)
        return () => undefined
      },
    })

    mount(ctx, { dir: root })
    await settle()

    assert.equal(captured.length, 0, '硬依赖缺失时 apply 不应运行')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('插件自带 cordis.patch.yml 的 null 空值不会让宿主启动失败', async () => {
  // 复刻 cordis.patch.yml 的 config 形状：`dir:` / `keyFile:` 这类空值在 YAML 里是
  // null，schemastery 对没有 default 的字段原样透传 null。旧实现在 resolveDir 里
  // 直接对 null 调 .trim()，抛出的 TypeError 会被 loader 包成
  // 「plugin tree failed to load」，整个 dsh 起不来。
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-cordis-'))
  const previousHome = process.env.DSH_HOME
  const captured: unknown[] = []
  const ctx = new Context()
  try {
    // 目录留空时回退到 $DSH_HOME，这里指到临时目录，避免污染真实 ~/.dsh。
    process.env.DSH_HOME = root
    ctx.provide('sessions', {})
    ctx.provide('systemPrompt', {
      context: (entry: unknown) => {
        captured.push(entry)
        return () => undefined
      },
    })

    mount(ctx, {
      dir: null,
      scope: null,
      keyFile: null,
      provider: null,
      model: null,
      skillExportDir: null,
      layerScopes: { episodic: 'project', semantic: 'global', technique: 'global', failure: 'global' },
    })
    await settle()

    assert.equal(captured.length, 3, 'null 应被视同未设置，插件仍需完成 prompt 接线')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
