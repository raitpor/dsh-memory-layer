/**
 * 技术栈探测器：从项目文件推断 {@link StackProfile}，作为技巧适用性的判据。
 *
 * 设计要点：
 *
 * 1. **核心通用**：`generic` + `node` 覆盖大多数仓库；生态特化（如 `minecraft`）以独立探测器加入，
 *    加新生态只需加一个函数，不动核心。
 * 2. **只读少量关键文件**：构建清单与依赖锁，不做全库扫描。
 * 3. **失败即无**：任何解析异常都退化为「该探测器不适用」，绝不让画像推断阻断调用方。
 *
 * @module dsh-memory-layer/stack/detectors
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StackProfile } from '../types.js'

/** 工作区文件视图：把「读项目文件」抽象出来，便于测试与替换。 */
export interface FileView {
  /** 工作区根目录（绝对路径）。 */
  readonly root: string
  /**
   * 读取工作区内的相对路径。
   * @param relativePath - 相对路径。
   * @returns 文本内容；文件不存在时 `undefined`。
   */
  read(relativePath: string): Promise<string | undefined>
  /**
   * 判断文件是否存在。
   * @param relativePath - 相对路径。
   * @returns 存在时为 `true`。
   */
  exists(relativePath: string): Promise<boolean>
}

/** 技术栈探测器。 */
export interface StackDetector {
  /** 探测器名，如 `generic` / `node` / `minecraft`。 */
  id: string
  /**
   * 推断画像。
   * @param view - 工作区文件视图。
   * @returns 画像；不适用时 `undefined`。
   */
  detect(view: FileView): Promise<StackProfile | undefined>
}

/** 判断一个未知错误是否为「文件不存在」。 */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * 基于真实文件系统构造文件视图。
 * @param root - 工作区根目录。
 * @returns 文件视图。
 */
export function createFileView(root: string): FileView {
  return {
    root,
    async read(relativePath) {
      try {
        return await readFile(join(root, relativePath), 'utf8')
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
    },
    async exists(relativePath) {
      try {
        await readFile(join(root, relativePath), 'utf8')
        return true
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    },
  }
}

/** 解析 JSON 对象；非法输入返回 `undefined`。 */
function parseJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** 取依赖清单里的全部依赖名（dependencies / devDependencies / peerDependencies）。 */
function dependencyNames(pkg: Record<string, unknown> | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (pkg === undefined) return out
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const bucket = pkg[field]
    if (typeof bucket !== 'object' || bucket === null) continue
    for (const [name, version] of Object.entries(bucket)) {
      if (typeof version === 'string' && !out.has(name)) out.set(name, version)
    }
  }
  return out
}

/** 已知框架清单：命中即写入 `frameworks` 与 `frameworkVersions`。 */
const KNOWN_FRAMEWORKS = [
  'react', 'vue', 'svelte', 'next', 'nuxt', 'angular', 'solid-js',
  'express', 'fastify', 'koa', 'hapi', '@nestjs/core', 'hono',
  'vite', 'webpack', 'esbuild', 'rollup',
  'jest', 'vitest', 'mocha', 'playwright',
] as const

/**
 * Node / TypeScript 项目探测器：读 `package.json` 与 `tsconfig.json`。
 * @param view - 工作区文件视图。
 * @returns 画像；无 `package.json` 时 `undefined`。
 */
export const nodeDetector: StackDetector = {
  id: 'node',
  async detect(view) {
    const pkg = parseJson(await view.read('package.json'))
    if (pkg === undefined) return undefined
    const languages = ['javascript']
    if (await view.exists('tsconfig.json')) languages.push('typescript')

    const frameworks: string[] = []
    const frameworkVersions: Record<string, string> = {}
    for (const [name, version] of dependencyNames(pkg)) {
      if ((KNOWN_FRAMEWORKS as readonly string[]).includes(name)) {
        frameworks.push(name)
        frameworkVersions[name] = version
      }
    }
    return {
      languages,
      buildTool: 'npm',
      ...(frameworks.length === 0 ? {} : { frameworks }),
      ...(frameworks.length === 0 ? {} : { frameworkVersions }),
    }
  },
}

/**
 * Minecraft 模组项目探测器：识别 loader 与 MC 版本约束。
 *
 * 这是「生态特化」的范例 —— 核心数据模型不认识 Minecraft，
 * 只有这个探测器把 `fabric.mod.json` / `mods.toml` 翻译成通用画像。
 *
 * @param view - 工作区文件视图。
 * @returns 画像；非模组项目时 `undefined`。
 */
export const minecraftDetector: StackDetector = {
  id: 'minecraft',
  async detect(view) {
    const fabric = parseJson(await view.read('fabric.mod.json'))
    const neoForge = await view.read('neoforge.mods.toml')
    const forge = await view.read('META-INF/mods.toml')
    if (fabric === undefined && neoForge === undefined && forge === undefined) return undefined

    const loader = fabric !== undefined ? 'fabric' : neoForge !== undefined ? 'neoforge' : 'forge'
    const properties = await view.read('gradle.properties')
    const mcVersion = minecraftVersion(fabric, properties)
    const sdks: { name: string; version?: string }[] = [{ name: `${loader}-loader` }]
    const hasGradle = (await view.exists('build.gradle')) || (await view.exists('build.gradle.kts'))

    return {
      ecosystem: 'minecraft',
      languages: ['java'],
      ...(hasGradle ? { buildTool: 'gradle' } : {}),
      sdks,
      ...(mcVersion === undefined
        ? {}
        : {
          versionConstraints: { minecraft: `~${minorOf(mcVersion)}` },
          versions: { minecraft: mcVersion },
        }),
    }
  },
}

/**
 * 取 MC 版本：优先 `gradle.properties` 的 `minecraft_version`，其次 `fabric.mod.json` 的依赖声明。
 * @param fabric - 已解析的 `fabric.mod.json`。
 * @param properties - `gradle.properties` 原文。
 * @returns 版本串；未知时 `undefined`。
 */
function minecraftVersion(
  fabric: Record<string, unknown> | undefined,
  properties: string | undefined,
): string | undefined {
  const fromProperties = properties === undefined
    ? undefined
    : /^\s*minecraft_version\s*=\s*(\S+)\s*$/mu.exec(properties)?.[1]
  if (fromProperties !== undefined) return fromProperties
  const depends = fabric?.['depends']
  if (typeof depends === 'object' && depends !== null) {
    const value = (depends as Record<string, unknown>)['minecraft']
    if (typeof value === 'string') {
      const match = /\d+\.\d+(?:\.\d+)?/u.exec(value)
      if (match !== null) return match[0]
    }
  }
  return undefined
}

/** 取 `major.minor` 前缀。 */
function minorOf(version: string): string {
  const parts = version.split('.')
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version
}

/**
 * 通用探测器：从构建清单识别语言与构建工具。
 * @param view - 工作区文件视图。
 * @returns 画像；未识别到任何构建清单时 `undefined`。
 */
export const genericDetector: StackDetector = {
  id: 'generic',
  async detect(view) {
    const languages: string[] = []
    const add = (language: string): void => {
      if (!languages.includes(language)) languages.push(language)
    }
    let buildTool: string | undefined

    const hasGradle = (await view.exists('build.gradle')) || (await view.exists('build.gradle.kts'))
    if (await view.read('build.gradle.kts') !== undefined) add('kotlin')
    if (hasGradle) {
      add('java')
      buildTool = 'gradle'
    }
    if (await view.read('pom.xml') !== undefined) {
      add('java')
      buildTool ??= 'maven'
    }
    if (await view.read('go.mod') !== undefined) {
      add('go')
      buildTool ??= 'go'
    }
    if (await view.read('Cargo.toml') !== undefined) {
      add('rust')
      buildTool ??= 'cargo'
    }
    if ((await view.read('pyproject.toml')) !== undefined || (await view.read('requirements.txt')) !== undefined) {
      add('python')
      buildTool ??= 'pip'
    }
    if (languages.length === 0) return undefined
    return { languages, ...(buildTool === undefined ? {} : { buildTool }) }
  },
}

/** 默认启用的探测器（顺序无关，结果按字段合并）。 */
export const DEFAULT_DETECTORS: readonly StackDetector[] = [
  minecraftDetector,
  nodeDetector,
  genericDetector,
]

/**
 * 合并两个画像：语言/框架/SDK 取并集，构建工具与生态取先出现的非空值。
 * @param base - 基础画像。
 * @param extra - 追加画像。
 * @returns 合并后的新画像。
 */
export function mergeStack(base: StackProfile, extra: StackProfile): StackProfile {
  const languages = [...new Set([...base.languages, ...extra.languages])]
  const frameworks = union(base.frameworks, extra.frameworks)
  const sdks = [...(base.sdks ?? []), ...(extra.sdks ?? [])]
    .filter((sdk, index, all) => all.findIndex(item => item.name === sdk.name) === index)
  const versionConstraints = {
    ...(base.versionConstraints ?? {}),
    ...(extra.versionConstraints ?? {}),
  }
  const versions = { ...(base.versions ?? {}), ...(extra.versions ?? {}) }
  return {
    languages,
    ...((base.ecosystem ?? extra.ecosystem) === undefined
      ? {}
      : { ecosystem: (base.ecosystem ?? extra.ecosystem) as string }),
    ...(frameworks === undefined ? {} : { frameworks }),
    ...(base.frameworkVersions === undefined && extra.frameworkVersions === undefined
      ? {}
      : { frameworkVersions: { ...(base.frameworkVersions ?? {}), ...(extra.frameworkVersions ?? {}) } }),
    ...(Object.keys(versionConstraints).length === 0 ? {} : { versionConstraints }),
    ...(Object.keys(versions).length === 0 ? {} : { versions }),
    ...(sdks.length === 0 ? {} : { sdks }),
    ...((base.buildTool ?? extra.buildTool) === undefined
      ? {}
      : { buildTool: (base.buildTool ?? extra.buildTool) as string }),
  }
}

/** 两个可选字符串数组合并去重；都为空时返回 `undefined`。 */
function union(left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])]
  return merged.length === 0 ? undefined : merged
}

/**
 * 对工作区跑一组探测器并合并结果。
 * @param view - 工作区文件视图。
 * @param detectors - 启用的探测器；缺省为 {@link DEFAULT_DETECTORS}。
 * @returns 合并后的画像；全部不适用时返回 `undefined`。
 */
export async function detectStack(
  view: FileView,
  detectors: readonly StackDetector[] = DEFAULT_DETECTORS,
): Promise<StackProfile | undefined> {
  let merged: StackProfile | undefined
  for (const detector of detectors) {
    let profile: StackProfile | undefined
    try {
      profile = await detector.detect(view)
    } catch {
      // 单个探测器失败不影响其余：画像推断必须是「尽力而为」的。
      profile = undefined
    }
    if (profile === undefined) continue
    merged = merged === undefined ? profile : mergeStack(merged, profile)
  }
  return merged
}
