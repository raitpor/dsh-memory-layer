# dsh-memory-layer

轻量级**跨会话本地记忆**插件 —— deepseek-harness (`dsh`) 原生 Cordis 插件。

它自动捕获会话内容，按**瞬时 / 情景 / 语义 / 技巧 / 失败**五层沉淀到本地磁盘，并在后续会话按相关度注入：
既记住「发生过什么」，也从代码与会话中提炼可复用的**技巧**（业务规则、专有 API 用法、流程与坑），
还认出反复犯的同一个错。零第三方运行时依赖、无外部服务、无数据库，默认加密落盘。

```
用户消息 ──▶ 瞬时层（当前会话要点，仅内存）
                │  每轮末
                ▼
             情景层（每次会话一条摘要 ── episodic.jsonl）
                │  摊销反思：每 reflectMinTurns 个新轮次一次 + 会话末兜底
                ▼
             语义层（长期事实与偏好 ── semantic.json）
             技巧层（抽象化知识 ── techniques.jsonl）
             失败层（反复犯的同一个错与处置 ── failures.jsonl）
                │
                ▼
     下一次会话 ──▶ BM25 召回 + 置信度排序 ──▶ system prompt 注入
                    + memory_* / technique_* / failure_* 工具
```

## 快速开始

### 安装

```sh
# 方式一：作为 bundle 安装（推荐）
dsh plugin --profile web add file:/path/to/dsh-memory-layer   # 本地路径，建议用绝对路径
dsh plugin --profile web add dsh-memory-layer                 # 发布到 registry 后可按包名安装

# 方式二：在 $DSH_HOME/cordis.patch.yml 手动挂载（片段见本包 cordis.patch.yml）
```

手动挂载片段：

```yaml
# 注意：patch 行的 `config` 是**整体替换**而非深合并 —— 只写部分字段会让其余字段回落 schema
# 默认值。把本包 `cordis.patch.yml` 的 config 整块拷来，再改你要改的字段。
- insert:
    - id: dsh-memory-layer
      name: 'dsh-memory-layer'   # 或插件目录的绝对路径
      config:
        layerScopes:
          episodic: project
          semantic: global
          technique: global
          failure: global
```

安装后**需要重启 dsh**：运行中的实例不会热加载新的 bundle 层。

### 验证

重启后让模型调用一次 `memory_stats`，会看到各层条数、作用域与运行指标（下例为示例值）：

```
Episodic: 12 | Semantic: 40 | Techniques: 466 (72 validated / 394 draft) | Failures: 69
Technique adoption: 72/466 adopted (15.5%), 207 searched at least once, 259 never searched
Technique references: 13/466 referenced at least once (2.8%), 60 event(s) [counter epoch 2]
Recurring failures: 61 active, 4 resolved, 108 prevented
Experience compounding: reflections=… skipped=… new=… duplicates=… backoff=…
Injection gate: N dropped / M kept
Session format: dsh-session 0.2.0-rc.1 → plugin message source kind 'plugin:dsh-memory-layer'
```

各行的含义：

| 行 | 含义 |
|---|---|
| `Technique adoption` | 已采用 / 总数、至少被显式检索过一次的条数、从未被检索过的草稿数 |
| `Technique references` | 被模型在工具参数里引用过的卡数 / 总数、引用事件数；`[counter epoch N]` 是引用计数的口径版本 |
| `Recurring failures` | 活跃失败记录、已解决记录、「预警后未复现」计数 |
| `Experience compounding` | 反思触发次数、被闸门跳过次数、新增记录数、重复合并数、是否处于退避 |
| `Reflection gate` | 最近一次「学不学」的判定理由（如 `new ground` / `novelty 0.02` / `no learning signal`） |
| `Injection gate` | 上一轮注入门槛拦下 / 放行的候选数 |
| `Recall dedupe` / `Restatement filter` | 近重复召回被丢弃数、复述候选被丢弃数 |
| `Store integrity` | 存储不健康时出现：整库不可读 / 跳过的坏行数 |

### 离线安装（无外网环境）

发布物里有**离线包**：一个自足的 tar.gz，内含 npm 包、解包副本、校验和与安装脚本。
本插件的**运行时依赖为零**（`package.json` 只有 `peerDependencies`，全部由宿主 dsh 提供），
而 dsh 的 profile 在 `pnpm-workspace.yaml` 里设了 `autoInstallPeers: false`，
所以 pnpm 不会去 registry 抓任何东西。

```sh
tar xzf dsh-memory-layer-<version>-offline.tar.gz
cd dsh-memory-layer-<version>-offline
./install.sh web        # 换成你的 profile 名
# 然后重启 dsh
```

`INSTALL.md` 里有四条路径：一条命令安装、手工 `dsh plugin add --offline`、
离线升级（含必须先删旧副本的步骤）、以及完全不走包管理器的 `cordis.patch.yml` 手工挂载。
`verify.sh` 做不联网自检（校验和、文件齐全、版本一致、`node --check`）。

自己打这个包：

```sh
npm run pack:offline     # → dist/dsh-memory-layer-<version>-offline.tar.gz（+ .sha256）
npm run verify:offline   # 用空 store + 不可路由的 registry 真装一遍
```

### 升级

`lib/` 不入库，且 `file:` 依赖在 profile 里是**硬链接**：改写已有文件会同步过去，
但**新增 / 删除 / 改名**的源文件不会（`pnpm install --force` 也不刷新）。
因此升级要走满三步，缺一步就可能让 dsh 启动失败（`ERR_MODULE_NOT_FOUND`）：

```sh
git pull && npm install && npm run build                            # 1. 重建 lib/
rm -rf "$DSH_HOME/profiles/<name>/node_modules/dsh-memory-layer"    # 2. 删掉 profile 里的旧副本
dsh plugin --profile <name> install --offline                       #    重装（硬链接指向新 lib/）
# 3. 重启 dsh —— lib/ 重建后，活体进程不会自动加载新代码
```

> 有些维护动作在**重启加载新版本后**才落盘（例如失败记录的重开、引用计数的口径迁移），
> 见下文「失败经验层」与「配置」里的 `techniqueMaintenance`。

## 五层记忆

| 层 | 内容 | 默认作用域 | 存储 |
|---|---|---|---|
| **瞬时** transient | 当前会话的要点（每轮的用户输入、助手输出、工具、文件） | — | 仅内存 |
| **情景** episodic | 每次会话**一条**摘要（标题、摘要、决定、待办、文件、标签） | `project` | `<scope>/episodic.jsonl` |
| **语义** semantic | 长期**事实与偏好**，按归一化 key 合并、累加命中次数 | `global` | `<scope>/semantic.json` |
| **技巧** technique | **抽象化的可复用知识**：业务规则、专有 API 调用法、流程、坑 | `global` | `<scope>/techniques.jsonl` |
| **失败** failure | **反复犯的同一个错**：指纹、重复次数、正确做法、处置强度 | `global` | `<scope>/failures.jsonl` |

`episodic` 默认留在项目域（它是原始会话摘要，含工作区路径与用户原话），其余层默认全局复用。
用 `layerScopes` 逐层调整，用 `partition` 划分全局域。

### 自动沉淀的时机

- **每轮末**：规则提炼（纯本地、零 token）抽取偏好 / 决定 / 待办 / 文件路径，写入瞬时层并在会话末归入情景层。
- **摊销反思**（默认开启）：每积累 `reflectMinTurns` 个**新**轮次有一次机会，会话末再兜最后一次。
  反思调用模型输出结构化 JSON，写入情景层，并把其中的长期事实并入语义层。
- **反思的三道闸门**（任一不满足就跳过，不花钱）：新增轮次与学习信号够不够；
  窗口里是否出现库未覆盖的新文件（是则直接反思），否则看词面新颖度是否达到 `reflectNoveltyThreshold`；
  产出侧再做**复述过滤**（与既有记录高度重合的候选丢弃）与**合并**（纯重复只累加命中次数）。
- **退避**：连续 `reflectBackoffAfterEmpty` 次反思无新产出后进入退避，此后**新领域**与**用户纠偏**
  仍能换来一次反思；退避期间的成本由 `memory_stats` 的 `Experience compounding` 可查。
- **模型不可用时**：提炼回退规则路径，纠偏认定改为本地判定（要求紧跟一次机械失败），记忆照常落盘。

### 技巧的信任状态与计数

| 概念 | 说明 |
|---|---|
| 知识形态 | `api-usage`、`business-rule`、`procedure`、`pitfall`、`env-recipe`、`code-logic` |
| 技术栈适用性 | 入库时记录语言 / 框架 / 版本约束；召回时不匹配即不注入 |
| 敏感级别 | `public / internal / confidential`；`confidential` 默认不进全局域 |
| 信任状态 | `draft → validated → canonical`，失败会 `deprecated`；**草稿不参与自动注入** |
| 置信度 | 由回报的成功 / 失败计数驱动（`(successes+1)/(successes+failures+2)`），直接参与排序 |
| 验收证据 | 回报必须附**可证伪**的证据（说清判据与观察结果）；只有结论词会被拒绝，且拒绝时不记账 |
| 采用标记 | 检索行与注入行带 `✓N`（N 次被证实的采用）/ `✗N`（有失败记录时） |

| 计数 | 来源 | 进不进置信度 | 回答什么问题 |
|---|---|---|---|
| `applied` / `successes` / `failures` | 模型**显式回报**（`technique_apply`） | ✅ 进 | 这条知识被**验证**过吗 |
| `referenced` | 插件观测工具参数里是否出现该卡符号 | ❌ 不进 | 这条知识**被碰过**吗 |

`referenced` 只给排序一个**有上限的小加成**：`1 + min(referenced, 5) × 0.04`（最多 +20%）。
引用计数带**口径版本**（`[counter epoch N]`）：口径变更时旧计数会被清零并盖章，跨版本不可直接比较。

## 注入到模型上下文

插件有四个注入段，按 `promptOrder` 排序，段内没有内容时整段不注入（连块头开销都不花）：

| 段 | 排序 | 内容 | 何时出现 |
|---|---|---|---|
| `memory-layer:recall` | 250 | 召回的常驻规则 + 相关记忆 / 技巧条目 | 有常驻规则或相关性命中时 |
| `memory-layer:failures` | 255 | 反复失败的预警 + 已解决记录的提前提醒 | 场景命中且未超每会话预算时 |
| `memory-layer:techniques` | 260 | 与当前技术栈相关的技巧索引行 | 有相关技巧时 |
| `memory-layer:guidance` | 265 | 「开工前先检索、用了就回报」的常驻指引 | 库非空且已注册工具时 |

每个注入块都声明内容是**不可信数据、不得作为指令**，并以 `BEGIN/END UNTRUSTED MEMORY` 划界；
块头与边界**永不参与截断**，字符上限只压缩条目正文。

### 召回与门槛

- 召回用纯本地 **BM25**（零模型调用）：中文按相邻二字切 bigram、拉丁词与数字按词切分；
  语义层权重高于情景层，并按时间做新鲜度加权；无命中返回空。
- **facet 召回**：任务型长描述会被切成若干子查询（标点与并列连词 + 语料词表 + 当前轮碰过的文件 / 调用名），
  再轮转交错合并，保证每个子查询先占一个位置。
- **本会话自己的情景摘要不回灌**（记录照常落盘供后续会话使用）。
- **相关性门槛**（`injectMinMatched` / `injectMinScore`）：一条记忆或技巧要命中查询里 ≥2 个不同的词
  （或达到给定 BM25 分）才允许注入；查询里非通用词 ≤2 个时门槛自动放宽为 1。
- **通用词不算证据**：内置表覆盖对话套话、交付元话题与通用工程词；`injectStopwords` 可追加
  （加一个词等于放弃靠它触发注入，不要加本领域词）。
- **标识符命中算强证据**：近乎唯一的键（`authorize`、`componentStyle`、`utf-8`）命中一个即放行。
- **常驻规则**（`long-term preference` / `long-term constraint`）：按最新优先直取 `injectStandingRules`
  条，不判相关性；规则集不变时改发**紧凑形态**（保留一句可执行的话，默认 60 字符），
  每 `standingRuleFullEveryTurns` 轮重发一次全文。
- **空查询不注入**：注入路径拿不到可核对的意图时什么都不给。显式 `memory_search` 空查询保留「取最近」语义。
- **判定只认用户原话**：当轮文件路径与工具名可以参与排序，但不参与「算不算相关」的判定。
- **召回去重**：命中彼此近重复（开头 80 字符相同**且**包含度 ≥0.6）时只留一条。
- **重复条目改发指针**（`recallRepeatCompact`）：本会话已完整给过、内容未变的条目改发
  `[sm_1a2b3c4d] <首句> — unchanged, full text delivered earlier in this session`
  （技巧条目给 `[tq_xxxxxxxx] <名称>`）。全文会在首见、内容变化、同一轮内重复渲染、
  以及距上次全文过 `standingRuleFullEveryTurns` 轮时重发；收到 `compaction/*` 事件时本会话记账整份作废。
- 以上规则只作用于**自动注入**：模型显式 `memory_search` / `technique_search` 一条不少。

### 动作点顾问

模型正要改某个文件 / 用某个符号时，若库里有证据命中的技巧且本会话还没推过，就在**工具回执之后**附一行
（`tools/post-execute` 的 `additionalContexts`，不阻断、不改写工具结果）：

```
· <技巧名> [tq_xxxxxxxx] matched <依据> — <要点> — technique_get for the full steps.
```

- 证据只取**文件名（basename）与命名实体**：路径键、枚举 / 状态值、纯数字都不算；
  拉丁证据词需 ≥5 字符，`chat` / `system` / `progress` 等在停用表内。
- 同一条知识只推一次，每轮最多一条，每会话预算 `techniqueAdvisoryMax`；草稿也会被推出并标 `(draft, unverified)`。
- **首触顾问**（`firstContactAdvisory`）：本会话还没查过库时，在动作点直接给一条与本轮请求最相关的
  （带要点），每个会话最多 `firstContactAdvisoryMax` 条。
- **改文件的动作点优先精确命中**（`edit` / `write`）：符号逐字出现在本次编辑里的卡优先；
  命中 ≥2 个针的卡更优先；本会话已在该文件上命中过针的卡，对**同一文件**的后续改动仍算精确命中。
  精确层里没有可推的卡时，回退到证据词规则。
- **引用提示**（`referenceNudge`）：检测到模型引用了某条被推给它的技巧时，附一行回报提示。

### 工作前先检索

`guidance` 段常驻三句话：开工前先查（`technique_search` / `memory_search`）、
适用就照做并回报 `technique_apply`、判错也回报 `failure`。
本会话还没查过库时，这一段会换成 `This session has not consulted the library yet: N verified + M draft(s) across <主题…>`，
首次检索后自动消失。

## 模型可用的工具

| 工具 | 用途 |
|---|---|
| `memory_search` | 按关键词检索跨会话记忆：返回 id、来源标签、得分、时间。`scope` 是真过滤：`project` / `global` / `all`（默认）。技巧层结果带信任状态 `(technique (draft))` / `(technique (validated))`，不过滤草稿 |
| `memory_save` | 写入一条长期事实 / 偏好 / 决定 / 约束（立即去重合并）。用户改口时用 `supersedes: <旧 id>`：新事实写入，旧的那条停止注入但仍可检索（标 `superseded`） |
| `memory_forget` | 按 id 删除；按前缀转交对应层（`sm_` / `ep_` 记忆层、`tq_` 技巧层、`fa_` 失败层）。默认跨全部作用域；`*` 清空需显式 `confirm: true`，只清情景 / 语义层 |
| `memory_stats` | 各层条数与作用域、采用率、引用计数、失败闭环、反思与注入指标（见「验证」一节的逐行说明） |
| `technique_search` | 按当前技术栈检索技巧。默认以已验证为主，草稿分数更高时在同一次响应里带出并标 `[draft]`，否则提示可加 `includeDrafts: true`；归档卡默认仍返回（`includeArchived: false` 可隐藏）；前 3 条给可执行要点 + 短 id，其余给指针，`verbose: true` 给完整索引行 |
| `technique_get` | 按 id（完整 id 或唯一前缀）展开正文：要点、步骤、调用面、示例、坑、验证判据与验收证据；`ids` 可一次展开多条 |
| `technique_save` | 手工写入一条草稿（与自动提炼同一条脱敏管线），或按 `id` **就地更新**：只替换显式给出的字段，计数 / 状态 / 验收记录保留。`kind: 'code-logic'` 写代码逻辑卡（`subject` / `location` / `steps` / `invariants` / `reuse` / `appliesTo`）。散文类字段的值里不要写 ASCII 双引号（用 `「」` 或反引号；`example` 例外） |
| `technique_apply` | 回报采用结果与可证伪的验收证据（`id` + `outcome` + `evidence`），驱动置信度与状态迁移；`updates[]` 可一次回报多条。已有回执（如 `npm test: 240/240`）即可当证据 |
| `technique_learn` | 从代码仓库挖掘技巧（显式、受限，产出为草稿）。回执列出本轮新建草稿的短 id 与名称 |
| `technique_export` | 把一条已验证技巧物化为 `SKILL.md`（`confidential` 拒绝导出） |
| `technique_forget` | 按 id 删除；`*` 清空需显式 `confirm: true` |
| `failure_list` | 列出反复犯的错（按重复次数排序）；`includeResolved` 可看已解决记录、触发方式与复发次数 |
| `failure_resolve` | 标记已解决，并记录**正确做法**与**触发场景**；场景再现时该记录会以 `[已解决…]` 条目提前提醒 |
| `failure_forgive` | 放行：本会话内不再就这条失败预警或拦截 |

`memory_forget` / `technique_forget` 的 `*` 清空是不可逆操作，其余按 id 的删除可逐条核对。

## 配置

所有字段都可选（`dir` 与 `skillExportDir` 有默认路径）。**分组列出默认值**：

### 存储与作用域

| 字段 | 默认 | 说明 |
|---|---|---|
| `dir` | `$DSH_HOME/memory-layer`（通常 `~/.dsh/memory-layer`） | 记忆库根目录 |
| `encrypt` | `true` | 是否加密落盘（AES-256-GCM，仅用 `node:crypto`） |
| `keyFile` | `<dir>/.dsh-memory-layer.key` | 密钥文件路径；也可用环境变量 `DSH_MEMORY_LAYER_KEY` 注入（hex / base64） |
| `layerScopes` | `episodic=project`，`semantic/technique/failure=global` | 按层设置作用域（`project` 按会话工作目录隔离，`global` 跨项目共享） |
| `partition` | `default` | 全局域分区（组织 / 租户） |
| `indexBackend` | `memory` | 检索后端：`memory`（内存 BM25）或 `sqlite`（FTS5 索引，可重建） |
| `registerTools` | `true` | 是否注册记忆工具 |
| `allowConfidentialGlobal` | `false` | 是否允许 `confidential` 知识进入全局域 |

### 注入与召回

| 字段 | 默认 | 说明 |
|---|---|---|
| `injectPrompt` | `true` | 是否把召回结果注入 system prompt（关掉后工具仍可用） |
| `promptOrder` | `250` | 召回段排序值 |
| `recallLimit` | `5` | 单次召回条数上限（1–20） |
| `recallChars` | `4000` | 条目正文字符上限；块头与边界永不截断 |
| `recallRepeatCompact` | `true` | 已给过且内容未变的条目改发指针形态 |
| `injectMinMatched` | `2` | 注入所需的最少命中词数（`0` 关闭该判据） |
| `injectMinScore` | `0` | 注入所需的最低 BM25 分（`0` 关闭该判据） |
| `injectStopwords` | `[]` | 追加到通用词表：命中它们不算相关 |
| `injectStandingRules` | `4` | 每轮强制注入的常驻规则条数（`0` 关闭） |
| `standingRuleFullEveryTurns` | `10` | 常驻规则与重复条目每隔几轮重发一次全文（`0` = 只在内容 / 规则集变化时重发） |
| `techniqueLimit` | `3` | 技巧段注入条数 |
| `techniqueChars` | `3000` | 技巧段字符上限 |
| `techniquePromptOrder` | `260` | 技巧段排序值 |
| `failureInjectLimit` | `3` | 失败段条目数上限 |
| `failureInjectChars` | `1500` | 失败段字符上限 |
| `failureInjectRelevantOnly` | `true` | 只注入与当前动作相关的预警（本会话确实犯过的指纹永远放行） |
| `failureInjectPerSession` | `5` | 每会话失败注入总量（`0` 不限） |
| `failurePromptOrder` | `255` | 失败段排序值 |
| `failurePreventWindowTurns` | `3` | 判定「防住了」的观察窗口（轮次） |
| `guidance` | `true` | 是否注入常驻指引段 |
| `guidancePromptOrder` | `265` | 指引段排序值 |
| `exampleMaxLines` | `8` | 技巧示例行数上限 |
| `exampleMaxChars` | `480` | 技巧示例字符上限 |

### 动作点顾问

| 字段 | 默认 | 说明 |
|---|---|---|
| `techniqueAdvisory` | `true` | 是否启用动作点顾问 |
| `techniqueAdvisoryDrafts` | `true` | 顾问是否连草稿一起看（会标 `(draft, unverified)`） |
| `techniqueAdvisoryMax` | `12` | 每会话顾问条数预算 |
| `firstContactAdvisory` | `true` | 未查过库的会话在动作点直接给一条最相关的 |
| `firstContactAdvisoryMax` | `1` | 每会话首触顾问条数（`0` 关闭） |
| `referenceNudge` | `true` | 引用到被推过的技巧时附一行回报提示 |

### 提炼与反思

| 字段 | 默认 | 说明 |
|---|---|---|
| `distillOnTurnEnd` | `true` | 每轮末用规则提炼兜底落盘 |
| `distillTimeoutMs` | `30000` | 会话结束提炼的超时（超时回退规则路径） |
| `reflectOnSessionEnd` | `true` | 会话内反思总开关 |
| `reflectMinTurns` | `3` | 两次反思之间所需的最少**新增**轮次 |
| `reflectNoveltyThreshold` | `0.15` | 新颖度低于此值不反思（`0` 关闭闸门） |
| `reflectBackoffAfterEmpty` | `5` | 连续无新产出后进入退避 |
| `reflectMaxTranscriptChars` | `24000` | 送审转录音符上限 |
| `provider` / `model` | 空 | 提炼调用的模型路由；留空则复用本会话最近一次请求的路由 |
| `captureUserChars` | `2000` | 每轮捕获的用户文本上限 |
| `captureAssistantChars` | `1200` | 每轮捕获的助手文本上限 |
| `maxTurnsPerSession` | `60` | 单会话保留的轮次要点上限 |

### 技巧层维护

| 字段 | 默认 | 说明 |
|---|---|---|
| `techniques` | `true` | 是否启用技巧层 |
| `techniqueMaintenance` | `true` | 是否在每次刷新时做领域名归一化、归档死重、口径迁移 |
| `archiveAfterDays` | `14` | 归档「从未被检索 / 引用 / 成功」的旧草稿所需的最小年龄（天） |
| `archiveKeepDomains` | `['dsh-', 'sdo']` | 豁免归档的领域前缀（也不参与领域上限计数） |
| `maxActiveDraftsPerDomain` | `150` | 单个领域活跃草稿上限；超限时归档该领域最老且从未被用过的 |

归档卡退出自动注入与排序，但 `technique_search` 默认仍返回、`technique_get` 仍能按 id 展开；
被 `technique_apply` 成功即自动撤销归档。`pitfall` 类知识永不自动归档。

### 失败经验层

| 字段 | 默认 | 说明 |
|---|---|---|
| `failures` | `true` | 是否启用失败经验层 |
| `failureMaintenance` | `true` | 是否在每次刷新时维护失败层：把「已标记解决、但计数证明之后又发生过」的记录重新打开（关掉后复发只由实时观测重开，存量记录不回溯迁移） |
| `failureWarnAfter` | `2` | 第几次重复开始注入预警 |
| `failureAskAfter` | `3` | 第几次重复开始在派发前询问 |
| `failureBlockAfter` | `0` | 第几次重复开始硬拦截（`0` = 从不） |
| `fingerprintTemplateMaxChars` | `200` | 归一化错误模板的字符上限 |
| `failureGuardTools` | `['bash']` | 允许自动推导守卫的工具白名单 |

### 代码挖掘

| 字段 | 默认 | 说明 |
|---|---|---|
| `mineUseModel` | `true` | 是否允许 `technique_learn` 调用模型归纳（关掉后仅规则路径） |
| `mineMaxFiles` | `200` | 单次挖掘文件数上限 |
| `mineMaxBytes` | `524288` | 单文件字节上限 |
| `mineMaxModelCalls` | `8` | 单次挖掘模型调用次数上限 |
| `mineMinOccurrences` | `2` | 结构候选成为技巧所需的最小出现次数 |
| `mineTimeoutMs` | `120000` | 单次挖掘总时长上限（超时保留已产出结果） |
| `mineInclude` / `mineExclude` | `[]` | 额外包含 / 排除的 glob |
| `mineStoreStructuralCards` | `false` | 是否把结构观察（调用面普查）也落成技巧卡；默认只写进挖掘回执 |

### 导出 Skill

| 字段 | 默认 | 说明 |
|---|---|---|
| `skillExportDir` | `<DSH_HOME>/skills` | 导出 `SKILL.md` 的目标目录 |
| `skillAllowedTools` | `[]` | 写入 `allowed-tools` 的白名单；留空不写该字段 |

## 存储与加密

```
<dir>/projects/<项目名>-<路径哈希>/episodic.jsonl
<dir>/projects/<项目名>-<路径哈希>/semantic.json
<dir>/projects/<项目名>-<路径哈希>/techniques.jsonl
<dir>/projects/<项目名>-<路径哈希>/failures.jsonl
<dir>/global/episodic.jsonl
<dir>/global/semantic.json
<dir>/global/techniques.jsonl
<dir>/global/failures.jsonl
<dir>/global/<分区>/...            # 非 default 分区落在 global/<分区>/ 下
<dir>/metrics.json                 # 反思（经验复利）指标
<dir>/mine-cache.json              # 代码挖掘的增量缓存（文件哈希 + 提示版本 + 模型）
<dir>/index.sqlite                 # 可选：sqlite 索引后端
```

- 情景层与技巧 / 失败层是 **JSONL**（可人工阅读、坏行被跳过），语义层是 **JSON 数组**。
  写入是**整体重写**：读全量 → 改 → 原子 `rename`，进程中断不会留下半截文件。
- 四层都有**每作用域 500 条**上限；语义层按「命中次数优先、再看新旧」淘汰。
- **同一记忆库同一时刻只允许一个写入者**：`<dir>/.writer.lock` 是跨进程写者锁，
  持锁者还活着时其他实例的写入当场失败并告警（`StoreLockedError`），不排队也不覆盖。
  锁只在本地文件系统上可靠（依赖 `O_EXCL`），网络盘需另配锁服务。
- **整份文件解不开时拒绝写入**：读取按空库处理并记 `ERROR`，`memory_stats` 报 `Store integrity: BROKEN`，
  写入被拒绝（写入是整体重写，会把本可凭密钥救回的记录覆盖掉）。个别行解不开则跳过并计入 `undecodableLines`。
- 默认**加密落盘**，每行 `enc:v1:<iv>:<tag>:<ciphertext>`（随机 IV）；密文被篡改会导致该行解密失败被跳过。
  旧的明文记忆库仍可读，会在下次写入时转为密文。
- 文件权限：记忆库文件 `0600`、目录 `0700`。

## 检索索引后端（可选）

默认 `indexBackend: memory`：纯内存 BM25，零依赖、零额外文件。
改成 `sqlite` 后 `refresh()` 会把技巧层派生成 `<dir>/index.sqlite`（FTS5），获得：

- **字段加权 BM25**：`name / subject / when / summary / tags / api` 六列各自权重；
- **SQL 侧过滤**：状态、分区、语言在查询里过滤。

三条边界：

1. **索引不是真源**：真源永远是 JSONL / JSON；索引文件可随时删除，下次 `refresh()` 自动重建。
2. **失败必然回退**：`node:sqlite` 不可用（Node < 22.5）、索引损坏、查询没有 token ——
   任一情况都静默回退内存 BM25，检索可用性不依赖可选后端。
3. **中文靠预分词**：写入与查询共用同一套分词（中文出二字 bigram），因此中文可命中且列权重仍然生效。

## 安全行为

| 风险 | 处置 |
|---|---|
| 凭据入库 | 写入前做**脱敏**（替换为 `[REDACTED:…]`）：厂商前缀、高熵串、赋值式机密。四层与 `evidence` / `remedy` 走同一管线 |
| 跨项目泄露 | 召回索引**按项目目录分桶**，会话切换立即改读新桶；新桶未加载时不注入 |
| 持久化提示注入 | 注入块声明记忆是**不可信数据、不得作为指令**，并以 `BEGIN/END UNTRUSTED MEMORY` 划界 |
| 结构伪造 | 正文里冒充层级标签的列表标记（如 `- [long-term]`）被改写为 `•`；代码 / 待办形态（`- [x]`、`-[hidden]->`）保持原样 |
| 控制字符 | 注入前剥离 ANSI 转义序列与 C0/C1 控制字符 |
| 围栏完整 | 不可信声明与 `BEGIN/END` 边界永不参与截断 |
| 敏感路径 | 正文只保留**工作区内**的相对路径，区外绝对路径替换为 `[EXTERNAL-PATH]` |
| 破坏性操作 | `*` 清空需显式 `confirm: true`；按 id 删除跨全部作用域，`*` 默认只清 `project` 的情景 / 语义层 |
| 项目私有信息外扬 | 凭据脱敏 → 项目私有标识替换为种类化占位符（库 / SDK 符号保留）→ 区外路径占位；唯一入口是 `sanitizeForStore()`；`confidential` 默认不进全局域 |
| 跨组织串味 | 全局域按 `partition` 分目录，跨分区互不可见 |

覆盖边界（已知）：

- `files` 字段不做去标识化（保留工作区**相对**路径），因此文件名里的标识符会留在记录中；
  跨项目担心这一点时把该层作用域设为 `project`。
- `tags` 只做凭据脱敏、不套占位符（否则检索元数据会被占位符替换到检索不到）。
- 标签改写只覆盖真实层级标签词表，自造标签（如 `- [system-prompt]`）不会被改写。
- 脱敏基于模式匹配，无法保证覆盖所有凭据形态；密钥与密文同处记忆库目录，
  需要更强隔离时用 `DSH_MEMORY_LAYER_KEY` 或把 `keyFile` 指向库外路径，或配合磁盘加密。

## 降级行为

插件只**硬依赖** `sessions` 服务，其余能力软探测：

| 缺少的服务 | 后果 |
|---|---|
| `llm` | 提炼回退到规则路径（仍落盘）；纠偏认定降级为本地，要求紧跟一次机械失败 |
| `systemPrompt` | 跳过 prompt 注入，工具与检索照常 |
| `tools` | 不注册记忆工具，注入与召回照常 |

## 失败经验层

### 指纹

机械指纹 = `sha1(工具名 + 错误名 + 错误码 + 归一化模板)`。归一化剥掉易变成分：绝对路径、
`file:line:col`、内存地址、哈希 / UUID、裸数字、点分版本号（收敛为 `VER`）、端口、耗时、时间戳、引号内字面量。

此外还有**语义指纹**：用户的直接纠偏本身会记成一条失败经验，键取 `sha1("sem:" + 归一化文本)`，
只做精确归一化匹配、不引入相似度阈值；这类记录没有守卫，只走预警，不会拦截。

### 纠偏判定

| 段 | 做什么 | 成本 |
|---|---|---|
| ① 本地初筛 | 命中触发词只记一个**候选**（不落记录），同时作为「值得花一次反思」的信号 | 零 token |
| ② 模型认定 | 反思那次调用顺带给出 `trigger / wrong / correctApproach`，三者齐全才落成失败记录 | 搭车 |

没有模型路由时降级为本地认定，且要求失败发生在**同轮或上一轮**。
落库的 `symptom` / `remedy` 取模型归一化后的表述。

### 处置阶梯

| 级别 | 条件（默认） | 动作 | 通道 |
|---|---|---|---|
| L0 静默记录 | 第 1 次 | 写入记录，不进入上下文 | — |
| L1 预警 | 第 2 次 | 注入预警（含正确做法；没有则要求先定位根因） | system prompt |
| L2 询问 | 第 3 次 | 派发前交给审批，用户可放行一次 | `tools/pre-execute` → `ask` |
| L3 拦截 | `failureBlockAfter`（默认 0 = 关闭） | 硬拒绝，理由含正确做法 | `ctx.tools.guard` |
| 提前提醒 | 已解决 + 场景命中 | 以 `[已解决…]` 条目给出触发场景与当时的做法 | system prompt |

升级阶梯只对**未解决**的记录生效；`[已解决…]` 条目不参与预警计数、询问与拦截。
三条硬约束：deny 可恢复（理由里给正确做法）、范围必须窄（绑定具体工具与参数）、
用户可逃生（`failure_forgive` 放行、`failure_resolve` 标记已解决）。

### 正确做法与守卫

- **remedy**：用户纠偏紧跟一次失败时，那句「应该怎么做」会挂到这条失败上；
  也可由 agent 用 `failure_resolve` 补写。没有 remedy 的预警只给次数与现场。
- **守卫**：只对 `failureGuardTools`（默认 `['bash']`）里的工具，从失败的真实参数里取一个窄字面量
  （如 `npm test`）。含路径分隔符、含凭据、短于 4 字符或长于 120 字符时放弃守卫。
- **文件编辑与读取永不被自动拦截**。

### 复发与提醒

- 已解决记录保留 `trigger`（触发方式）与当时的做法；之后按**场景**挑出该提醒的记录
  （当前会话用过同一个工具，或触发方式与最近的用户输入 / 文件 / 工具有 ≥2 个词重合），
  以 `[已解决…]` 条目追加在失败段末尾。只提醒有 remedy 的记录。
- **复发会重新打开记录**：已解决的记录再次真的发生时，清掉 `resolvedAt`、状态回到 `validated`、
  `relapses` 加一，并在**第一回合直接预警**：

  ```
  [已解决后又复发（第 1 次复发，本回合第 1 次）] Error: cannot modify …: file has not been read —
  正确做法：改前先 read — id fa_…
  ```

- 升级强度按**回合内**次数算（`occurrencesAtReopen` 之后的增量），再次 `failure_resolve` 时回合基线清空。
- 旧版本写下的「已解决但计数证明之后又发生过」的记录会在 `techniqueMaintenance` 里自动重开
  （**重启加载新版本后**生效）。
- **闭环度量**：`prevented` = 预警发出后观察窗口内该指纹未再复现；`memory_stats` 报
  `Recurring failures: N active, M resolved, K prevented`。
- 插件自己的拒绝带错误码 `MEMORY_LAYER_FAILURE_GUARD`，观测时排除，不计入失败次数。

## 代码挖掘

`technique_learn` 从**已经写过的代码**里提炼可复用知识（显式、受限的操作）：

```
扫描分类 → 结构分析 → 候选聚类 → 抽象归纳 → 去标识化 + 泄漏校验 → 草稿落盘
```

两条产出路径，形状一致：

| 路径 | 成本 | 产出 |
|---|---|---|
| **规则**（永远先跑） | 零 token | 纯结构统计：「`X.y` 在 service-layer 里被调用 3 次，参数 1–2 个」 |
| **模型** | 受调用次数与总时长双重约束 | 归纳出「什么时候用 / 怎么做 / 哪里会错」，再经同一套校验 |

边界与闸门：

| 闸门 | 做法 |
|---|---|
| 扫描范围 | 依赖 / 构建目录黑名单 + `.gitignore`（支持 `!` 反选、目录限定、`*` / `**`）+ 文件数与字节数上限 |
| 语言无关 | 只做浅层结构分析（调用名 / 参数个数、守卫语句、注解） |
| 知识而非代码 | 示例行数与字符数硬上限；规则路径不产出代码 |
| 泄漏校验 | 逐字连续 ≥8 词重合、或残留项目私有标识 → 拒绝入库并记原因 |
| 隐私 | 证据只存仓库别名 + 角色 + 抽象描述，不存真实路径；产出仍是草稿 |
| 增量 | 按「文件内容哈希 + 提示版本 + 模型」缓存，未变文件跳过 |

## 导出为 Skill

`technique_export` 把一条**已验证**技巧物化成标准 `SKILL.md`，写在 `<skillExportDir>/<skill 名>/SKILL.md`：

| 约束 | 说明 |
|---|---|
| 只有 `validated` / `canonical` 能导出 | 未经验证的草稿不会以「技能」身份生效 |
| `confidential` 拒绝导出 | 机密不进入账号级共享域 |
| 写盘前跑 `verifySkill` 自检 | 前言键不被加载器接受时直接失败，而不是「装上了但不生效」 |

- skill 名会追加 id 片段以避同名覆盖；非 ASCII 名（纯中文）slug 后为空时回退到 `technique-<id>`。
- `description` 里写明「做什么」与「何时用」并带触发词与标签 —— 它是唯一被语义检索索引的文本。
- 导出后由你决定怎么装载（本 harness 的 skills 机制，或 OpenViking 的 `add_skill`）。**插件不会自行上传**。

## 开发与发布

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # 构建 + node --test
```

> `devDependencies` 对齐到 dsh `0.1.5-rc.x` 版本线：`@deepseek-ai/*` 包彼此互为 peer，
> 混用不同版本线会导致 npm 解析冲突。**运行时**两条线都支持，见下。

### 兼容的 dsh 版本线

同时支持 **`0.1.5-rc.x`（会话格式 v3）** 与 **`0.2.0-rc.1`（会话格式 v4）**：
peer 范围写成 `^0.1.5-rc.1 || ^0.2.0-rc.1`（`engines.node >= 20`）。
两条线之间唯一影响本插件的差异是**消息来源的形状**：v3 要求 `source: { kind: 'plugin', plugin: <名> }`，
v4 要求插件来源提升为 `kind: 'plugin:<名>'`。插件按实际安装的 `@deepseek-ai/dsh-session` 次版本号选形状
（`messageSourceFor`），注入过滤两条线都认。

验证方式（`.verify/` 整体不入库，`.verify/compat/` 是维护者本地夹具，不随包发布）：

```sh
npm test                                       # 当前版本线
npx tsc -p .verify/compat/tsconfig-020.json    # 对 0.2.0-rc.1 的 .d.ts 做类型检查
node --import ./.verify/compat/redirect.mjs --test lib/test/   # 在 0.2.0 线上跑同一套用例
```

> 后两条依赖本机的 0.2.0-rc.1 安装；换机器时按 `.verify/compat/paths.json` 改成对应路径。

活实例上可确认选定的形状（`memory_stats` 输出）：

```
Session format: dsh-session 0.2.0-rc.1 → plugin message source kind 'plugin:dsh-memory-layer'
Session format: dsh-session 0.1.5-rc.2 → plugin message source kind 'plugin'
```

## 已知限制

- **技巧示例是重建产物**：用于说明怎么调，不是可直接编译的代码。
- **采用回报依赖模型显式调用 `technique_apply`**：用了但没回报会被漏记。
- **反思成本是「上限有界、分布前重后轻」**：触发早于「每会话一次」，由 `reflectMinTurns`、新颖度闸门与退避共同限制。
- **技术栈画像可能推断失败**：推断不到时不做过滤，语言闸门不生效。
- **去标识化是最小版**：凭据模式匹配 + 显式标识符 + 从代码文件路径推导的私有标识；
  泄漏校验只作用于代码挖掘路径（会话反思的产出没有来源代码可比对）。
- **反思的新颖度是词面口径**：同义改写会算作「新」。
- **纠偏认定发生在反思时**（每 `reflectMinTurns` 个新轮次 + 会话末），不是说话当下。
- **已解决记录的提醒是场景匹配**：可能漏提醒（换个说法匹配不上）也可能多提醒（工具名相同、语境不同）。
- **失败指纹不归一化未加引号的可变标识符**：`Cannot find module aaa` 与 `... bbb` 会记成两条。
- **remedy 不自动推导**：需要 agent 用 `failure_resolve` 或用户纠偏补写，之后预警质量才完整。
- **「同触发另解」是保守近似**：触发条件归一化后相同即并置呈现，不做语义蕴含判断。
- **导出不自动装载**：插件只写文件，是否安装与共享由用户决定。
- **挖掘是浅层结构分析**：规则路径产出偏描述性，「怎么用 / 什么时候用」依赖模型路径。
- **结构观察默认不入库**（`mineStoreStructuralCards: false`）：调用面普查属于仓库观察。
- **`domain` 在写入口归一化**（去空白、转小写、查别名表）：别名表新增条目可能让两条原本不同的记录撞键，
  因此只收明确的同义写法。
- **挖掘候选需出现 ≥`mineMinOccurrences` 次**：孤例技巧抓不到。
- **`.gitignore` 只支持常用子集**：复杂语法按字面处理，漏规则只影响扫描范围。
- **拦截会阻断正常工作**：默认 `failureBlockAfter: 0`（从不硬拦截），需显式开启。
- **失败层写入被串行化**：所有失败写入走同一条 FIFO 链，吞吐略降。
- **`prevented` 是窗口内的近似归因**：预警后观察窗口内未复现即计一次。
- **`appliesTo` 闸门是保守的**：`module=` 只按当前轮碰过的文件路径判定，认不出的键与散文写法一律放行；
  版本闸门走写入时抓的画像（`record.stack`），与 `appliesTo` 里的版本串是两套东西。
- **语义层的「取代」要显式声明**：不声明 `supersedes` 时新旧两条会同时存在并同时注入；
  被取代的记录仍能被 `memory_search` 查到（标 `superseded`）。
- **补充检索键按话题延续判定**：更早轮次碰过的文件 / 工具只在该轮用户文本与当前请求有共同 token 时才算，
  换个说法继续同一话题时可能丢掉上一轮的线索。
- **草稿要走「检索 → 采用 → 回报」才会变成已验证**：自动注入不收草稿；
  `technique_search` 在草稿分数更高时当场带出，`memory_search` 不过滤并标 `(technique (draft))`。
  检索遥测只统计显式检索。
- **召回不做 embedding**：零依赖 BM25，同义改写的查询召回不到。
- **召回按项目分桶缓存**：会话切换后的首轮可能暂时没有记忆注入。
- **凭据脱敏是模式匹配**：不保证穷尽。
- **加密的边界**：默认密钥与密文同处记忆库目录，主要防「明文被 git / 云盘 / 索引 / 误 `cat` 带出」。
- **密钥丢失不可恢复，且必须在任何写入之前恢复**：只要发生过一次成功写入，旧密文就被整体覆盖；
  请把密钥与记忆库一同备份。
- **损坏行的容忍只到「个别行」**：明文库里被人工改坏的 JSON 行会被静默跳过，且不计入 `undecodableLines`。
- **提炼失败静默回退**：模型路径的任何异常都回退规则路径并记日志，不中断会话。
- **情景层同会话覆盖**：一次会话只保留最新一条摘要。

## 设计文档

技巧经验层的完整设计（数据模型、习得路径、适用性、召回与生命周期、分期验收）见
仓库 [`docs/design/2026-09-22-dsh-memory-layer技巧经验层设计.md`](../../docs/design/2026-09-22-dsh-memory-layer技巧经验层设计.md)。
架构图见 [`docs/architecture.puml`](./docs/architecture.puml)（渲染件在 `docs/rendered/`）。

## 鸣谢

本插件开发任务主要由 **deepseek-v4.1-flash** 完成。

## 许可证

[MIT](./LICENSE) © 2026 raitpor
