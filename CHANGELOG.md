# 变更记录

本插件遵循[语义化版本](https://semver.org/lang/zh-CN/)。`0.x` 期间 `minor` 版本可能包含**破坏性变更**。

## 0.2.0 — 生产化：写入互斥、密钥不匹配 fail-closed、检索分档

### 破坏性变更

- **`technique_apply` 必须附可证伪的验收证据**：签名从 `(id, outcome)` 变为 `(id, outcome, evidence)`。
  `evidence` 是 required 参数，必须说清「按什么判据检查、看到什么结果」，且含至少一个具体锚点
  （数字 / 引号或反引号包住的记号 / 路径 / URL）。只有结论词（`ok`、`已采用`、`通过`）会被拒绝，
  且**拒绝时不记账**：计数、状态与验收记录都不动。
- **`canonical` 的晋升额外要求至少一条带证据的验收记录**：三次「用了就算成功」不再够。
- **`technique_get` 的 `id` 不再是 required**：改为与新增的 `ids` 二选一，由执行期校验。

### 新增

- **验收记录**：`technique_apply` 的每次采用都落盘一条 `{outcome, evidence, at, sessionId, cwd}`，
  最新在前、最多 5 条、单条证据收敛到 400 字符；`technique_get` 展开时可见。
- **`technique_search` 结果分两档**：命中前 3 条给一句话可执行要点（`gist`）+ 短 id，其余只给
  「还存在」的指针。实测（124 条真实技巧库 × 7 查询 × 3 档 limit）检索输出减少 **48.1%**。
  `verbose: true` 退回旧的完整索引行。
- **`technique_get` 支持唯一前缀 id 与批量展开**：`id` 可写 `tq_f6233ebe` 这样的前缀；`ids` 一次展开多条。
  前缀歧义时报错并列出候选，不猜。
- **`gist` 字段**：`technique_save` 可选；缺省时从 `summary` 首句派生。它与其他正文字段走同一条
  脱敏管线。
- **写入互斥**：`<dir>/.writer.lock` 跨进程写者锁 + 进程内串行链，覆盖四层的全部「读全量 → 改 →
  整体重写」路径。持锁者活着时其他写入**当场失败并告警**，不再静默覆盖（此前两个实例并发写会丢记录：
  实测 20 条只活下来 10 条）。
- **密钥不匹配时 fail-closed**：整份文件解不开（密钥不对 / 密文损坏）时记 `ERROR` 日志、
  在 `memory_stats` 报 `Store integrity: BROKEN`，并**拒绝一切写入** —— 否则一次写入就会把还能靠
  密钥救回来的记录永久覆盖。个别行解不开仍然容忍，但会计数。
- **语义层容量上限**：每作用域 500 条，按「命中次数优先、再看新旧」淘汰（此前无上限，而它是
  单行 JSON 整表重写）。
- **CI**：`.github/workflows/ci.yml` 跑 `typecheck` + `npm test`。

### 交付

- **离线安装包**：`npm run pack:offline` 产出 `dsh-memory-layer-<version>-offline.tar.gz`，
  内含 npm 包、解包副本（供 `cordis.patch.yml` 手工挂载）、`manifest.json`（逐文件 sha256）、
  `checksums.txt`、`install.sh`、`verify.sh` 与 `INSTALL.md`。
  本插件零运行时依赖 + profile 关闭 peer 自动安装，因此可断网安装。
- **`npm run verify:offline`**：在空 pnpm store + 不可路由 registry 下**真装一遍**，
  校验落地产物与 `node --check`。CI 的门槛就是它，不是「测试过了」。
- **CI/CD**：`ci.yml`（typecheck → test → 打离线包 → 离线装一遍 → 上传产物，带 `concurrency`
  与最小 `permissions`）与 `release.yml`（打 tag 即发布：校验 tag 与 `package.json` 版本一致、
  CHANGELOG 有对应小节、测试、打包、离线安装验证、生成校验和并创建 Release）。
- `npm pack` 前置 `prepack` 构建：不再可能打出一个没有 `lib/` 或 `lib/` 过期的包。

### 修复

- `technique_apply` 的 `evidence` 是新增写入路径，此前**没过 `sanitizeForStore()`**：凭据与工作区外
  绝对路径会原样入库。现已与其余四层同口径。
- 空洞结论判定是**永远走不到的死代码**（整串匹配置于长度闸门之后，词表里没有一条备选达到 12 字符），
  且带数字的空洞结论可以绕过。改为「去掉数字与标点后是否只剩结论词拼接」并前置。
- 验收证据此前无长度上限，会被 `technique_get` 反复注入上下文，现收敛到 400 字符。
- README：新增「离线安装」小节；修正「情景层是 JSONL：追加友好」（实际是整体重写）、「密钥丢失……读取时被跳过」
  （实际是**拒绝写入**，且恢复密钥必须在任何写入之前）、补上「升级三步」与小节 `memory_stats` 的
  健康度输出。

## 0.1.0 — 首个版本

四层记忆（瞬时 / 情景 / 语义 / 技巧）+ 失败经验层、BM25 召回与注入、会话内摊销反思、代码挖掘、
失败升级阶梯（预警 / 询问 / 拦截）与闭环度量、`SKILL.md` 导出、AES-256-GCM 加密落盘与统一安全管线。
