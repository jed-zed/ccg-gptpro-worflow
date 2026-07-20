# Grok External Intelligence Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将官方 Grok Build CLI 落地为 CCG 的外部情报与事实核验层，以真实 Web/X 工具事件建立可审计证据，接入 GPT Pro 与全部 CCG 工作流，并在用户明确同意后由主编排器自动判断是否搜索。

**Architecture:** 保留现有通用 `codeagent-wrapper --backend grok`；另增隔离的 intelligence profile。Go wrapper 负责最小权限启动、精确环境、私有原始事件文件和进程限制；零第三方依赖的 Node.js ESM runtime 负责路由、只读聚焦快照、真实事件归一化、运行时 source registry、证据校验、缓存、canonical task evidence 和报告。required gate 首版只使用契约探针验证过的单 agent 模型；deep multi-agent 仅作 advisory，并明确 leader-only 可见性。

**Tech Stack:** Node.js 20 ESM、TypeScript 5.9、Vitest、Go 1.21+ 标准库、PowerShell doctor、Markdown command/skill templates、TOML/JSON/JSONL、GitHub Actions Windows/Ubuntu matrix。

---

## 0. 复审裁决、范围与硬门禁

设计基线：[2026-07-20-grok-external-intelligence-orchestrator-design.md](../specs/2026-07-20-grok-external-intelligence-orchestrator-design.md)。本计划的安全修订优先于设计稿中关于默认启用、快照写入、X 必选和 deep model 审计范围的旧描述；Task 1 会同步设计稿，避免双重真相。

本地核验结果：

- 接受：脏工作区必须真正隔离；intelligence profile 禁止 `--always-approve`；不得继承完整 `os.Environ()`；真实 CLI contract probe 必须先于事件实现；旧配置必须默认关闭；deep multi-agent 只能声称 leader 可见事件；必须复用 `.ccg/tasks/<task-id>/evidence.json`；必须增加 Windows CI。
- 接受：`grok-cli` 与既有 `grok-search` MCP 明确仲裁；required evidence 只接受官方 CLI 内置搜索事件，默认不 fallback。
- 拒绝：附件声称本地包/插件版本为 `3.1.3`/`3.1.0`。本地 `package.json`、两个 marketplace 和 Codex plugin manifest 均为 `3.2.2`；目标版本仍为 `3.3.0`。
- 动态处理：不得把任何远端 SHA 或本地 `cb7039d` 写成通过条件；以执行时记录的 branch、HEAD 和 patch SHA-256 为准。

官方约束：

- CLI 自动化参数、`grok inspect --json`、模型与权限参数：<https://docs.x.ai/build/cli/reference>
- `dontAsk`、allow/deny policy、sandbox 平台边界与认证：<https://docs.x.ai/build/enterprise>
- `GROK_HOME`：<https://docs.x.ai/build/settings>
- Claude plugins/MCP/instructions 的兼容发现：<https://docs.x.ai/build/features/skills-plugins-marketplaces>、<https://docs.x.ai/build/features/mcp-servers>
- multi-agent 只公开 leader 工具调用且全部 agent 计费：<https://docs.x.ai/developers/model-capabilities/text/multi-agent>、<https://docs.x.ai/developers/pricing>

四个阻断门禁：

1. **Baseline Gate:** Task 0A 未建立独立 feature branch（优先 worktree；权限阻断时允许当前 checkout fallback）和已审查 prerequisite commit，不得实施。
2. **Contract Gate:** Task 0B 未取得真实、脱敏的 Windows Web/X JSONL fixture 和 `inspect` allowlist，不得编写 event normalizer。
3. **Safety Gate:** exact env、临时 home、`dontAsk`、无 shell/edit、无 Web UI/普通日志、bounded exclusive raw file 任一不满足，不得发布手动命令。
4. **Consent Gate:** 升级用户与非交互安装默认关闭；init 不得隐式发起付费模型调用。

完成定义：

- 普通 Grok backend 行为兼容；intelligence profile 不含 `--always-approve`，不开放 Bash/Edit/任意 terminal。
- `/ccg:grok-intel`、`/ccg:grok-verify`、`ccg doctor --grok`、`ccg doctor --grok-live` 可用。
- 主编排器在用户 opt-in 后自动判断是否需要搜索；required 失败两次重试后 fail closed，只有显式 user waiver 可继续。
- 严格证据的 URL 全部来自真实 built-in CLI tool events；模型不能新增 URL、伪造 retrieved time 或自行决定 blocker tier。
- 完整 bundle 保存在默认忽略的 `.codex/ccg/intelligence/<evidence-id>/`，并向 canonical task evidence 写入紧凑条目。
- deep manifest 明示 `evidence_visibility: "leader_only"`，可见事件数不冒充总 server tool usage。
- Node 20/22 与 Go tests 在 Ubuntu/Windows 通过；付费 live smoke 仅手动或本地 release gate 运行。
- 不自动 publish、push、创建 release，也不手动上传 wrapper binary。

## Task 0A: 将当前脏基线隔离到独立 worktree

**Files:**

- Inspect: repository-wide tracked and untracked state
- Preferred: create inside ignored worktree root `I:\ai\ccg-workflow\.worktrees\grok-intelligence`
- Permission fallback: keep the current checkout but switch it from `main` to `codex/grok-intelligence` before committing

- [ ] **Step 1: 记录动态基线并生成原字节 binary patch**

```powershell
Set-Location I:\ai\ccg-workflow
$baselineHead = git rev-parse HEAD
$baselineBranch = git branch --show-current
$baselinePatch = Join-Path $env:TEMP "ccg-grok-intelligence-baseline.patch"
git diff --binary --full-index HEAD --output=$baselinePatch
$baselinePatchSha256 = (Get-FileHash -Algorithm SHA256 $baselinePatch).Hash.ToLowerInvariant()
$untracked = @(git ls-files --others --exclude-standard)
[ordered]@{
  baseline_head = $baselineHead
  baseline_branch = $baselineBranch
  baseline_dirty_patch_sha256 = $baselinePatchSha256
  baseline_untracked_paths = $untracked
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $env:TEMP "ccg-grok-intelligence-baseline.json") -Encoding utf8
git status --short
```

Expected: JSON uses the current values; no fixed SHA is asserted; current worktree content and index are unchanged.

- [ ] **Step 2: 创建功能 worktree 并应用 tracked baseline**

```powershell
Set-Location I:\ai\ccg-workflow
git worktree add -b codex/grok-intelligence I:\ai\ccg-workflow\.worktrees\grok-intelligence $baselineHead
Set-Location I:\ai\ccg-workflow\.worktrees\grok-intelligence
git apply --binary --index $baselinePatch
```

Copy only the reviewed untracked prerequisite tests (`src/utils/__tests__/doctor.test.ts` and `src/utils/__tests__/pluginParity.test.ts`) plus these two planning artifacts if they are present in the original worktree:

```text
docs/superpowers/specs/2026-07-20-grok-external-intelligence-orchestrator-design.md
docs/superpowers/plans/2026-07-20-grok-external-intelligence-orchestrator.md
```

Stage those four explicit paths after reading them in the new worktree. Do not copy `.ccg/`, `.codex/`, `output/`, `tmp/`, attachments, caches, or credentials.

```powershell
$sourceRoot = "I:\ai\ccg-workflow"
$targetRoot = "I:\ai\ccg-workflow\.worktrees\grok-intelligence"
$reviewedUntracked = @(
  "src/utils/__tests__/doctor.test.ts",
  "src/utils/__tests__/pluginParity.test.ts",
  "docs/superpowers/specs/2026-07-20-grok-external-intelligence-orchestrator-design.md",
  "docs/superpowers/plans/2026-07-20-grok-external-intelligence-orchestrator.md"
)
foreach ($relativePath in $reviewedUntracked) {
  $source = Join-Path $sourceRoot $relativePath
  if (Test-Path -LiteralPath $source) {
    $destination = Join-Path $targetRoot $relativePath
    New-Item -ItemType Directory -Force (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
    git add -- $relativePath
  }
}
```

- [ ] **Step 3: 审查 prerequisite staged patch，禁止混入未知 hunk**

```powershell
git diff --cached --check
git diff --cached --name-status
git diff --cached
pnpm typecheck
pnpm test
Push-Location codeagent-wrapper
go test ./...
Pop-Location
```

Expected: staged patch is exactly the already completed upstream sync/generic Grok backend/doctor/GPT Pro prerequisite work. If any hunk cannot be attributed, stop and ask the user; do not commit it speculatively.

- [ ] **Step 4: 提交独立 prerequisite baseline**

```powershell
git commit -m "chore: capture Grok workflow prerequisites"
git status --short
```

Expected in the preferred path: implementation worktree is clean except this plan/spec copy if it was not in the original patch; original worktree still has its original dirty patch and identical SHA-256. In the permission fallback below, the current checkout retains the same files but moves to the feature branch before the baseline commit.

If a freshly created Windows/Codex worktree cannot read tracked files even though their ACL and HEAD hashes are valid, verify and remove only that newly created worktree, then use the approved sandbox fallback:

```powershell
Set-Location I:\ai\ccg-workflow
git switch codex/grok-intelligence
git branch --show-current
git rev-parse main
```

Expected: current branch is `codex/grok-intelligence`, `main` still points to `baseline_head`, and the recorded dirty patch SHA-256 remains recoverable. Do not continue on `main`.

- [ ] **Step 5: 固定所有后续提交门禁**

Every later commit must use `git add -p -- <overlapping-files>` for files that existed in the baseline patch, explicit `git add -- <new-files>` for new files, then run:

```powershell
git diff --cached --check
git diff --cached --name-status
git diff --cached
```

No later task may use `git add .`, `git add -A`, `reset`, `stash`, or `checkout --`.

## Task 0B: 先完成真实 Grok CLI contract probe

**Files:**

- Create after successful probe: `docs/verification/grok-cli-contract-windows.md`
- Create from redacted real output: `templates/engine/tools/grok-intelligence/fixtures/*.jsonl`
- Mirror: `plugins/ccg/skills/ccg-grok-intel/scripts/grok-intelligence/fixtures/*.jsonl`

- [ ] **Step 1: 检查安装和认证，不自动复制用户 Grok home**

```powershell
grok version
grok --help
grok models
grok inspect --json
```

If `grok` is absent, use the official Windows installer only after the user has authorized installation. Required v1 automation auth is `XAI_API_KEY`. Do not copy the whole `~/.grok` browser-login state into a temporary home; other auth providers require a later, separately probed design.

- [ ] **Step 2: 建立 neutral home 并验证配置发现隔离**

```powershell
$probeRoot = Join-Path $env:TEMP ("ccg-grok-probe-" + [guid]::NewGuid().ToString("N"))
$neutralHome = Join-Path $probeRoot "home"
$grokHome = Join-Path $probeRoot "grok"
New-Item -ItemType Directory -Force $neutralHome,$grokHome | Out-Null
@"
[compat.claude]
mcps = false
"@ | Set-Content (Join-Path $grokHome "config.toml") -Encoding utf8
$env:HOME = $neutralHome
$env:USERPROFILE = $neutralHome
$env:GROK_HOME = $grokHome
grok inspect --json | Set-Content (Join-Path $probeRoot "inspect.json") -Encoding utf8
```

Inspect must prove there are no loaded MCP servers, plugins, hooks, skills, agents, marketplaces, project/user instruction origins, or unexpected tools. An empty neutral `AGENTS.md` is not a substitute for inspecting origins.

- [ ] **Step 3: 探测准确 flag、工具名和单 agent Web/X 事件**

Run bounded paid probes only with explicit live consent. Start without guessed `--tools`; use `--help`/`inspect` to derive the actual allow/deny syntax, then repeat with the narrowest working allowlist.

```powershell
$webPrompt = "Use the built-in Web Search exactly once. Find the official xAI Grok CLI reference page, return its canonical URL and one dated fact. Do not run shell commands or edit files."
$xPrompt = "Use the built-in X Search exactly once. Find an official xAI account post about Grok Build CLI, return the post URL and date. Do not run shell commands or edit files."
grok --no-auto-update --permission-mode dontAsk --no-memory --no-subagents --max-turns 6 --output-format streaming-json -p $webPrompt 2>&1 | Set-Content (Join-Path $probeRoot "web.jsonl") -Encoding utf8
grok --no-auto-update --permission-mode dontAsk --no-memory --no-subagents --max-turns 6 --output-format streaming-json -p $xPrompt 2>&1 | Set-Content (Join-Path $probeRoot "x.jsonl") -Encoding utf8
```

Record the exact working tool identifiers and policy syntax in the contract report. Required fields are: CLI version, available models, search start/result/error event kinds, call ID stability, source URL field, result payload field, final assistant event, exit code behavior, timeout/cancel behavior, and whether usage metadata is present.

- [ ] **Step 4: 探测 deep model 的可见性边界**

Run one bounded deep probe with and without `--no-subagents` only if the model exists. Verify whether the flag affects CLI client subagents, server-side multi-agent, or both. The acceptance rule is fixed:

```json
{
  "required_gate_model": "grok-4.5",
  "deep_gate_eligible": false,
  "evidence_visibility": "leader_only",
  "total_server_tool_usage": null
}
```

Even if usage metadata is present, deep remains advisory in v1.

- [ ] **Step 5: 探测错误边界**

Exercise: invalid model, denied tool, timeout, Ctrl+C/cancellation, nonzero exit, malformed/truncated stream, raw cap, missing auth, and Windows process-tree termination. Save exit codes and the last redacted event.

- [ ] **Step 6: 由真实输出生成脱敏 fixtures**

Redact tokens, cookies, local usernames, drive paths, query identifiers and account IDs while preserving event keys, event ordering, call IDs, URLs, status and usage shapes. Required fixtures:

```text
web-success.jsonl
x-success.jsonl
web-error.jsonl
denied-tool.jsonl
timeout-truncated.jsonl
deep-leader-only.jsonl
inspect-clean.json
```

Add a fixture provenance table with original file SHA-256, redacted fixture SHA-256, CLI version, capture date and redaction rules. Hand-authored idealized event schemas are forbidden.

- [ ] **Step 7: Contract Gate**

Do not continue unless Windows single-agent probes expose stable built-in search events containing source URLs and a distinguishable final assistant payload. If this fails, revise the architecture to the official xAI API or ACP in a new design; do not fake compatibility.

## Task 1: 同步设计勘误并加入 opt-in 配置契约

**Files:**

- Modify: `docs/superpowers/specs/2026-07-20-grok-external-intelligence-orchestrator-design.md`
- Modify: `src/types/index.ts`
- Modify: `src/utils/config.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/i18n/index.ts`
- Test: `src/utils/__tests__/config.test.ts`

- [ ] **Step 1: 先写旧配置默认关闭和新安装显式同意的失败测试**

```ts
expect(normalizeIntelligenceConfig(undefined, { existingInstall: true })).toMatchObject({
  enabled: false,
  auto_route: false,
  deep_research_enabled: false,
  live_checks_on_init: false,
  provider: 'grok-cli',
  legacy_search_provider: 'grok-search-mcp',
  allow_provider_fallback: false,
})

expect(createDefaultConfig({ ...baseOptions, intelligenceConsent: false }).intelligence.enabled)
  .toBe(false)
expect(createDefaultConfig({ ...baseOptions, intelligenceConsent: true }).intelligence)
  .toMatchObject({ enabled: true, auto_route: true })
```

Also test non-interactive `--skip-prompt` without an explicit intelligence flag remains disabled.

- [ ] **Step 2: Run red**

```powershell
pnpm vitest run src/utils/__tests__/config.test.ts
```

Expected: FAIL because the intelligence types and consent path do not exist.

- [ ] **Step 3: Implement the exact typed config**

```ts
export type XSearchPolicy = 'required' | 'preferred' | 'disabled'

export interface IntelligenceConfig {
  enabled: boolean
  auto_route: boolean
  provider: 'grok-cli'
  legacy_search_provider: 'grok-search-mcp'
  allow_provider_fallback: false
  default_model: string
  deep_research_model: string
  deep_research_enabled: boolean
  live_checks_on_init: false
  artifact_root: string
  max_retries: number
  max_bundle_bytes: number
  retention_days: number
  exported_retention_days: number
  require_web_search: boolean
  x_search_policy: XSearchPolicy
}
```

Defaults: disabled/false for old or non-interactive installs; `grok-4.5`, `grok-4.20-multi-agent`, 2 retries, 16 MiB bundle, 7-day local retention, 30-day exported retention, Web required, X preferred. `incident` elevates preferred to required; `landscape` remains preferred; `disabled` is never elevated. X-only evidence can never create a blocker.

- [ ] **Step 4: Add explicit init consent disclosure**

The prompt must state data sent (focused source snapshot and task text), Web/X use, token/tool-call cost, local artifact path, fail-closed behavior and that init itself performs no paid smoke. `--intelligence` is the only non-interactive opt-in; `--no-intelligence` is explicit opt-out.

- [ ] **Step 5: Update the design document**

Replace unsafe defaults, arbitrary snapshot writes, mandatory landscape X, `/ccg:doctor --grok` paid behavior and deep full-audit claims with this plan's consent, safety, doctor split and leader-only rules.

- [ ] **Step 6: Green and commit**

```powershell
pnpm vitest run src/utils/__tests__/config.test.ts
pnpm typecheck
git add -p -- src/types/index.ts src/utils/config.ts src/commands/init.ts src/i18n/index.ts
git add -- docs/superpowers/specs/2026-07-20-grok-external-intelligence-orchestrator-design.md src/utils/__tests__/config.test.ts
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(config): add opt-in external intelligence settings"
```

## Task 2: 实现 Go wrapper 的最小权限 intelligence transport

**Files:**

- Modify: `codeagent-wrapper/config.go`
- Modify: `codeagent-wrapper/backend.go`
- Modify: `codeagent-wrapper/executor.go`
- Modify: `codeagent-wrapper/main.go`
- Modify: `codeagent-wrapper/logger.go`
- Modify: `codeagent-wrapper/backend_test.go`
- Modify: `codeagent-wrapper/main_test.go`
- Create: `codeagent-wrapper/intelligence_transport_test.go`
- Modify: `src/utils/installer.ts`

- [ ] **Step 1: 写安全参数、exact env 和普通 backend 兼容测试**

Required test assertions:

```text
generic Grok stays compatible and receives --no-auto-update
intelligence never contains --always-approve
intelligence contains permission-mode=dontAsk, no-memory, no-subagents, bounded max-turns
tool allowlist exactly matches the probe contract
Bash/Edit/terminal tools are denied or absent
Linux/macOS may add sandbox=strict; Windows never claims sandbox support
intelligence uses SetExactEnv; generic backends retain SetEnv behavior
intelligence starts no WebServer and creates no normal wrapper log
```

- [ ] **Step 2: 写 raw event 私有目录和 cap 的失败测试**

Replace caller-selected `--raw-events-file` with:

```text
--grok-intelligence
--raw-events-dir <absolute-private-directory>
--raw-events-max-bytes <1..8388608>
--raw-events-max-events <1..20000>
```

Tests require exclusive random filename creation, refusal of existing file selection, symlink/junction/reparse rejection, owner-only directory validation, byte/event cap termination, cleanup on cancel, and one machine-readable `CCG_RAW_EVENTS_FILE=<absolute-path>` stderr line.

- [ ] **Step 3: Run red**

```powershell
Push-Location codeagent-wrapper
go test ./...
Pop-Location
```

- [ ] **Step 4: Add exact environment semantics**

Add `SetExactEnv(map[string]string)` to `commandRunner`. The intelligence allowlist is only:

```text
PATH, HOME, USERPROFILE, GROK_HOME, TEMP, TMP, TMPDIR,
SystemRoot, WINDIR, ComSpec, PATHEXT,
LANG, LC_ALL,
XAI_API_KEY,
HTTPS_PROXY, HTTP_PROXY, NO_PROXY,
SSL_CERT_FILE, SSL_CERT_DIR, NODE_EXTRA_CA_CERTS
```

Omit unset variables. Point HOME/USERPROFILE/GROK_HOME to runner-created neutral directories. Never pass GitHub, cloud, database, npm, Anthropic, OpenAI, Gemini or arbitrary `CCG_*` variables.

- [ ] **Step 5: Build arguments from the checked-in contract**

Use the contract's exact tool IDs and syntax. All automated Grok calls get `--no-auto-update --output-format streaming-json`. Intelligence adds `dontAsk`, no memory/subagents, max turns, explicit search/read allowlist and shell/edit deny rules. The generic backend may retain its existing approval behavior for compatibility, but the intelligence branch must not share that argument slice.

- [ ] **Step 6: Disable side channels and bound raw tee**

The profile forces no WebServer and no persistent logger before either is initialized. Tee stdout bytes to an exclusively created `0600` file inside the validated directory; count bytes and newline-delimited events; cancel the process tree and return a distinct nonzero code when a cap is reached. Do not truncate and continue.

- [ ] **Step 7: Version wrapper protocol together**

```text
codeagent-wrapper/main.go: version = "5.13.0"
src/utils/installer.ts: EXPECTED_BINARY_VERSION = "5.13.0"
```

- [ ] **Step 8: Green, security gate and commit**

```powershell
Push-Location codeagent-wrapper
go test ./...
go test -race ./...
Pop-Location
pnpm vitest run src/utils/__tests__/installer.test.ts
pnpm typecheck
git add -p -- codeagent-wrapper/config.go codeagent-wrapper/backend.go codeagent-wrapper/executor.go codeagent-wrapper/main.go codeagent-wrapper/logger.go codeagent-wrapper/backend_test.go codeagent-wrapper/main_test.go src/utils/installer.ts
git add -- codeagent-wrapper/intelligence_transport_test.go
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(wrapper): isolate Grok intelligence transport"
```

## Task 3: 实现真实事件 normalizer 和运行时 source registry

**Files:**

- Create: `templates/engine/tools/grok-intelligence/lib/events.mjs`
- Create: `templates/engine/tools/grok-intelligence/lib/source-registry.mjs`
- Create: `templates/engine/tools/grok-intelligence/lib/validator.mjs`
- Create: `templates/engine/tools/grok-intelligence/lib/contracts.mjs`
- Create: `src/utils/__tests__/grokIntelligenceEvents.test.ts`

- [ ] **Step 1: 用 Task 0B fixtures 写 parser red tests**

Tests must recognize only contract-probed event kinds, preserve unknown events for diagnostics, correlate call IDs, distinguish Web/X/result/error/final events, reject prose-only “I searched”, and fail on truncated/malformed required streams.

- [ ] **Step 2: 写 source registry 的不可伪造测试**

```js
const registry = buildSourceRegistry(realToolEvents, { retrievedAt: fixedClock })
expect(registry.sources[0]).toMatchObject({
  id: expect.stringMatching(/^src-[a-f0-9]{16}$/),
  tool: 'web_search',
  canonical_url: 'https://docs.x.ai/build/cli/reference',
  retrieved_at: fixedClock,
})
expect(() => bindClaims([{ url: 'https://invented.invalid' }], registry)).toThrow(/unobserved source/i)
```

Canonicalization removes fragments and tracking parameters, normalizes scheme/host/default ports, preserves semantically relevant query parameters, and deduplicates equivalent URLs. IDs are runtime-generated from canonical URL plus tool kind.

- [ ] **Step 3: Add deterministic source policy**

Runtime assigns official-domain status and base tier from configured domain policy; the model may suggest but cannot elevate it. Blocker claims need either one authoritative primary source plus observed applicability, or two independent reputable sources. X is radar only and cannot independently block.

- [ ] **Step 4: Add two-stage collection/synthesis**

Stage A performs built-in search and builds the registry. Stage B receives only registry IDs and normalized event excerpts, with search/shell/edit disabled, and emits claims referencing registry IDs. Any URL in Stage B output is rejected. If the probe cannot establish a no-tool synthesis mode, perform deterministic binding from observed URLs and require all claimed URLs to be a registry subset.

- [ ] **Step 5: Green and commit**

```powershell
pnpm vitest run src/utils/__tests__/grokIntelligenceEvents.test.ts
git add -- templates/engine/tools/grok-intelligence/lib src/utils/__tests__/grokIntelligenceEvents.test.ts
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(intelligence): normalize Grok search evidence"
```

## Task 4: 实现数据最小化快照和安全 runner

**Files:**

- Create: `templates/engine/tools/grok-intelligence/lib/snapshot.mjs`
- Create: `templates/engine/tools/grok-intelligence/lib/private-temp.mjs`
- Create: `templates/engine/tools/grok-intelligence/lib/process.mjs`
- Create: `templates/engine/tools/grok-intelligence/runner.mjs`
- Create: `templates/engine/tools/grok-intelligence/fake-wrapper.mjs`
- Create: `src/utils/__tests__/grokIntelligenceRunner.test.ts`

- [ ] **Step 1: 写 snapshot red tests**

Fixtures cover `.env*`, credentials, keys/certs, `.git`, dependency trees, caches, `.ccgignore`, instruction/plugin surfaces (`AGENTS.md`, `CLAUDE.md`, `.claude`, `.codex`, `.grok`, skills, hooks and plugin manifests), symlink escape, Windows junction/reparse escape, path traversal, hardlink duplicate, file-count cap, per-file cap, total-byte cap and dirty diff scoping.

- [ ] **Step 2: Implement snapshot as data minimization, not sandbox**

Copy only router-selected source/config/lockfile/diff context. Never copy VCS metadata, auth files, model instruction files, plugin/MCP/hook/skill directories or ignored paths. Set copied files read-only where supported. Grok receives no write/edit/shell tool, so snapshot writes are not a feature. Trusted CCG-side fixed reproductions are out of scope for v1.

- [ ] **Step 3: Create private temp roots**

POSIX requires mode `0700`. Windows uses `icacls` from the trusted runner to remove inheritance, grant the current SID full control and verify the resulting DACL. Create separate neutral home, GROK_HOME, snapshot and raw directories; write `[compat.claude] mcps=false`; reject reparse points after creation.

- [ ] **Step 4: Add clean inspect preflight**

Before every paid run, execute `grok inspect --json` under exact env and verify the checked-in contract's allowed origins/tools. A mismatch is `unsafe_cli_context`, is not retried, and fails required runs closed.

- [ ] **Step 5: Implement runner lifecycle**

The runner validates config/consent, creates temp roots, snapshots, runs inspect, invokes wrapper, parses `CCG_RAW_EVENTS_FILE`, redacts the stream, validates events, retries transient errors in a new session up to two times, kills process trees on timeout/cap, and deletes every unredacted temp file in `finally`.

Exit contract:

```text
0 = valid evidence or valid skip
2 = required evidence unavailable/invalid
3 = unsafe CLI context or policy violation
4 = user consent/configuration missing
```

- [ ] **Step 6: Test with fake wrapper**

Fake cases: success, retry-then-success, rate limit, timeout, cancellation, malformed JSON, missing search, invented URL, dirty snapshot, inspect pollution, raw cap and cleanup failure. Tests assert argv, exact env keys, call order and no surviving unredacted file.

- [ ] **Step 7: Green and commit**

```powershell
pnpm vitest run src/utils/__tests__/grokIntelligenceRunner.test.ts
git add -- templates/engine/tools/grok-intelligence src/utils/__tests__/grokIntelligenceRunner.test.ts
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(intelligence): add isolated Grok runner"
```

## Task 5: 建立 bundle、cache、waiver 与 canonical task evidence

**Files:**

- Create: `templates/engine/tools/grok-intelligence/lib/artifacts.mjs`
- Create: `templates/engine/tools/grok-intelligence/lib/cache.mjs`
- Create: `templates/engine/tools/grok-intelligence/lib/router.mjs`
- Modify: `templates/hooks/task-utils.js`
- Modify: `templates/engine/evidence-schema.md`
- Modify: `.gitignore`
- Test: `src/utils/__tests__/grokIntelligenceArtifacts.test.ts`
- Test: `src/utils/__tests__/evidenceSchema.test.ts`

- [ ] **Step 1: 写 bundle 和自哈希 red tests**

Each successful/skipped/waived run writes exactly:

```text
.codex/ccg/intelligence/<evidence-id>/manifest.json
.codex/ccg/intelligence/<evidence-id>/evidence.json
.codex/ccg/intelligence/<evidence-id>/report.md
.codex/ccg/intelligence/<evidence-id>/raw-stream.jsonl
```

`manifest.json` hashes only evidence/report/raw. Its own SHA-256 is stored in the task pointer and canonical evidence item. Atomic temp-write + rename is mandatory; evidence IDs reject separators, `..`, drive prefixes and reserved names.

- [ ] **Step 2: Define decision and waiver schema**

```json
{
  "requirement": "required",
  "status": "waived",
  "mode": "contract",
  "reason": "Grok unavailable after bounded retries",
  "waiver": {
    "reason": "User accepts stale external-contract risk",
    "actor": "user",
    "created_at": "2026-07-20T00:00:00.000Z"
  }
}
```

No model or implicit timeout may create a waiver. Required failures remain exit 2 until an explicit user-authored waiver is supplied.

- [ ] **Step 3: Define deep visibility fields**

```json
{
  "evidence_visibility": "leader_only",
  "observed_web_search_events": 2,
  "observed_x_search_events": 1,
  "total_server_tool_usage": null,
  "advisory_only": true
}
```

- [ ] **Step 4: Build versioned cache fingerprint and lock**

Fingerprint includes normalized task/mode/search policy/model, git HEAD, dirty/plan/diff digest, lockfiles, target versions/domains and:

```text
runner_version, wrapper_protocol_version, cli_version,
prompt_template_sha256, evidence_schema_version, router_policy_version,
source_tier_policy_version, event_normalizer_version, snapshot_policy_version
```

Tests cover concurrent same-key lock, atomic rename conflict, future timestamps, failed/degraded/contradicted evidence exclusion, CLI upgrade miss, force refresh, stale TTL and path traversal.

- [ ] **Step 5: Append compact canonical evidence**

```json
{
  "id": "grok-external-intelligence-<evidence-id>",
  "provider": "grok",
  "role": "external-intelligence",
  "policy": "required",
  "available": true,
  "artifactFile": ".codex/ccg/intelligence/<evidence-id>/evidence.json",
  "artifactSha256": "<evidence-sha256>",
  "manifestFile": ".codex/ccg/intelligence/<evidence-id>/manifest.json",
  "manifestSha256": "<manifest-sha256>",
  "summary": "Validated current external contract evidence"
}
```

Extend the generic normalizer/validator rather than adding a Grok-only validation stack. `resolveArtifactPath()` must resolve both `.ccg/` and `.codex/` from the project root, reject escapes from the project root, preserve `manifestFile`/`manifestSha256`, and validate both hashes when present. `task.json` stores only requirement/status/evidence ID/manifest pointer/localOnly/exported.

- [ ] **Step 6: Retention and export policy**

Ignore `.codex/ccg/intelligence/` in Git. Raw is redacted but local-only; default local retention 7 days. `--export <dir>` emits a separately sanitized bundle without raw by default, marks `exported: true`, enforces 30-day retention and 16 MiB maximum. Cleanup removes expired bundles and orphan private temp dirs, never active task evidence.

- [ ] **Step 7: Green and commit**

```powershell
pnpm vitest run src/utils/__tests__/grokIntelligenceArtifacts.test.ts src/utils/__tests__/evidenceSchema.test.ts
git add -p -- templates/hooks/task-utils.js templates/engine/evidence-schema.md .gitignore
git add -- templates/engine/tools/grok-intelligence/lib/artifacts.mjs templates/engine/tools/grok-intelligence/lib/cache.mjs templates/engine/tools/grok-intelligence/lib/router.mjs src/utils/__tests__/grokIntelligenceArtifacts.test.ts
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(intelligence): persist canonical Grok evidence"
```

## Task 6: 先发布手动 MVP 与拆分 doctor

**Files:**

- Create: `templates/commands/grok-intel.md`
- Create: `templates/commands/grok-verify.md`
- Create: `plugins/ccg/skills/ccg-grok-intel/SKILL.md`
- Create: `plugins/ccg/skills/ccg-grok-verify/SKILL.md`
- Create: `plugins/ccg/commands/grok-intel.md`
- Create: `plugins/ccg/commands/grok-verify.md`
- Mirror runtime: `plugins/ccg/skills/ccg-grok-intel/scripts/grok-intelligence/`
- Modify: `src/utils/installer-data.ts`
- Modify: `src/utils/installer.ts`
- Modify: `src/cli-setup.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `plugins/ccg/scripts/doctor.ps1`
- Modify: `plugins/ccg/skills/ccg-doctor/SKILL.md`
- Modify: `plugins/ccg/commands/doctor.md`
- Test: `src/utils/__tests__/grokIntelligenceDistribution.test.ts`
- Test: `src/utils/__tests__/doctor.test.ts`

- [ ] **Step 1: Write distribution parity red tests**

Assert command registration, installed runtime executability, byte-identical shared `.mjs`/fixture files, no unresolved template variables, and no use of legacy `mcp__grok-search` in strict commands.

- [ ] **Step 2: Add manual commands**

`/ccg:grok-intel` supports mode/depth/force-refresh/export and defaults to single-agent normal depth. `/ccg:grok-verify` binds evidence to plan/diff/dependency digests. Both print requirement/status/search counts/evidence path/hash and propagate exits 2/3/4.

- [ ] **Step 3: Split doctor behavior**

```text
ccg doctor --grok       = binary, version, help flags, models, auth presence,
                          isolated inspect, config/provider conflict, retention cleanup;
                          no model prompt and no paid Web/X call
ccg doctor --grok-live  = explicit bounded paid Web/X smoke and event validation
```

Init may call only the local doctor checks after explicit opt-in. It never calls `--grok-live`.

- [ ] **Step 4: Diagnose provider arbitration**

Doctor warns if `grok-search` MCP exists but does not remove it. It verifies `provider=grok-cli`, `legacy_search_provider=grok-search-mcp`, fallback false, Claude MCP compatibility disabled in the neutral home, and strict gates accepting only built-in CLI events.

- [ ] **Step 5: Add cleanup checks**

Doctor reports expired bundles, orphan private temp directories, over-size bundles and invalid canonical pointers; cleanup requires an explicit flag and never deletes active evidence.

- [ ] **Step 6: Green and commit**

```powershell
pnpm vitest run src/utils/__tests__/grokIntelligenceDistribution.test.ts src/utils/__tests__/doctor.test.ts src/utils/__tests__/installWorkflows.test.ts
powershell -NoProfile -ExecutionPolicy Bypass -File plugins/ccg/scripts/doctor.ps1 -PluginRoot plugins/ccg -Json
pnpm typecheck
git add -p -- src/utils/installer-data.ts src/utils/installer.ts src/cli-setup.ts src/commands/doctor.ts plugins/ccg/scripts/doctor.ps1 plugins/ccg/skills/ccg-doctor/SKILL.md plugins/ccg/commands/doctor.md
git add -- templates/commands/grok-intel.md templates/commands/grok-verify.md plugins/ccg/skills/ccg-grok-intel plugins/ccg/skills/ccg-grok-verify plugins/ccg/commands/grok-intel.md plugins/ccg/commands/grok-verify.md src/utils/__tests__/grokIntelligenceDistribution.test.ts
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(intelligence): add Grok commands and doctor"
```

## Task 7: 让 GPT Pro Plan、Exc、Review 复用 canonical Grok evidence

**Files:**

- Modify: `templates/engine/tools/gptpro/gptpro_bridge.py`
- Modify: `plugins/ccg/skills/ccg-gptpro-bridge/scripts/gptpro_bridge.py`
- Modify: `templates/commands/gptpro-plan.md`
- Modify: `templates/commands/gptpro-exc.md`
- Modify: `templates/commands/gptpro-review.md`
- Modify: corresponding `plugins/ccg/skills/ccg-gptpro-*/SKILL.md`
- Modify: corresponding `plugins/ccg/commands/gptpro-*.md`
- Test: `src/utils/__tests__/gptproBridge.test.ts`

- [ ] **Step 1: Write generic evidence-consumer red tests**

Required Grok item must validate through the same canonical artifact resolver/hash/path boundary used by Gemini/GPT Pro evidence. Tests reject missing item, wrong policy/role, path escape, evidence hash mismatch, manifest hash mismatch, local pointer drift and waived-without-user metadata.

- [ ] **Step 2: Generalize the bridge validator**

Add provider/role requirements rather than a second Grok manifest parser. Status stores a concise `external_intelligence` block with evidence ID, mode, requirement/status, manifest/evidence paths and hashes. Prompts receive only validated summary/claims/provenance; never raw JSONL, secrets or full page bodies.

- [ ] **Step 3: Enforce workflow order**

Plan: external intelligence before Gemini/Codex planning evidence and manual GPT Pro session creation. Exc: preflight contract evidence before route review; verify evidence after implementation when external digest changes. Review: diff-bound verify before GPT Pro handoff. Required exit 2 stops bridge creation; explicit waiver is displayed prominently.

- [ ] **Step 4: Green, parity and commit**

```powershell
pnpm vitest run src/utils/__tests__/gptproBridge.test.ts src/utils/__tests__/pluginParity.test.ts
git add -p -- templates/engine/tools/gptpro/gptpro_bridge.py plugins/ccg/skills/ccg-gptpro-bridge/scripts/gptpro_bridge.py templates/commands/gptpro-plan.md templates/commands/gptpro-exc.md templates/commands/gptpro-review.md
git add -p -- plugins/ccg/skills/ccg-gptpro-plan/SKILL.md plugins/ccg/skills/ccg-gptpro-exc/SKILL.md plugins/ccg/skills/ccg-gptpro-review/SKILL.md plugins/ccg/commands/gptpro-plan.md plugins/ccg/commands/gptpro-exc.md plugins/ccg/commands/gptpro-review.md
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(gptpro): require canonical Grok provenance"
```

## Task 8: 首批 opt-in 自动路由与行为测试

**Files:**

- Create: `templates/engine/tools/grok-intelligence/route.mjs`
- Create: `templates/engine/tools/grok-intelligence/workflow-coverage.json`
- Modify representative main workflow templates: `templates/commands/go.md`, `templates/commands/gptpro-plan.md`, `templates/commands/gptpro-exc.md`, `templates/commands/gptpro-review.md`
- Modify representative plugin workflows: `plugins/ccg/skills/ccg-go/SKILL.md`, `plugins/ccg/skills/ccg-gptpro-*/SKILL.md`
- Test: `src/utils/__tests__/grokIntelligenceRouting.test.ts`
- Test: `src/utils/__tests__/grokIntelligenceWorkflowBehavior.test.ts`

- [ ] **Step 1: Implement only three initial automatic gates**

With `enabled=true && auto_route=true`:

```text
dependency/API contract intake -> mode=contract, requirement=required
current incident diagnosis      -> mode=incident, Web required, X policy-derived
final diff external verify      -> mode=verify, requirement inherited/re-evaluated
```

All other task classes initially produce an auditable skip reason. Disabled or missing config makes zero subprocess/model calls.

- [ ] **Step 2: Test actual behavior, not markers**

The test harness invokes `route.mjs` with fake runner and asserts argv, mode, requirement, call order, state file, diff/dependency digest invalidation, exit 2 propagation and skip reason. A template string marker alone is insufficient.

- [ ] **Step 3: Test X policy**

Incident elevates preferred to required; landscape preferred never fails solely because X is unavailable; disabled never invokes X; X-only claims remain warning/hypothesis.

- [ ] **Step 4: Green and commit**

```powershell
pnpm vitest run src/utils/__tests__/grokIntelligenceRouting.test.ts src/utils/__tests__/grokIntelligenceWorkflowBehavior.test.ts
git add -- templates/engine/tools/grok-intelligence/route.mjs templates/engine/tools/grok-intelligence/workflow-coverage.json src/utils/__tests__/grokIntelligenceRouting.test.ts src/utils/__tests__/grokIntelligenceWorkflowBehavior.test.ts
git add -p -- templates/commands/go.md templates/commands/gptpro-plan.md templates/commands/gptpro-exc.md templates/commands/gptpro-review.md plugins/ccg/skills/ccg-go/SKILL.md plugins/ccg/skills/ccg-gptpro-plan/SKILL.md plugins/ccg/skills/ccg-gptpro-exc/SKILL.md plugins/ccg/skills/ccg-gptpro-review/SKILL.md
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(workflows): add opt-in Grok intelligence gates"
```

## Task 9: 扩展到全部 CCG、Team、Spec 和质量门禁

**Files:**

- Modify: `templates/commands/*.md` and `templates/engine/strategies/*.md` entries listed in `workflow-coverage.json`
- Modify: `plugins/ccg/commands/*.md` and `plugins/ccg/skills/*/SKILL.md` entries listed in `workflow-coverage.json`
- Test: `src/utils/__tests__/grokIntelligenceWorkflowBehavior.test.ts`
- Test: `src/utils/__tests__/pluginParity.test.ts`

- [ ] **Step 1: Expand coverage manifest by family**

Required families and representative executable cases:

```text
go / plan
execute / feat
review / verify
team
spec
gptpro
quality gates
```

Git-only commands (`commit`, `rollback`, `clean-branches`, `worktree`, `context`) remain default skips unless the user explicitly invokes a Grok command.

- [ ] **Step 2: Use one shared route contract everywhere**

Every workflow calls the installed mirrored `route.mjs`, supplies task/mode/phase/plan/diff/dependency/state paths, honors disabled config, propagates exit 2/3/4, persists a reason, and re-evaluates when plan/dependency/target/diff/phase digest changes.

- [ ] **Step 3: Add family behavior tests**

Each family uses fake runner to verify invocation order and state mutation. Team tests prove one shared evidence decision rather than duplicate calls per teammate. Spec tests bind proposal/plan/diff digests. Quality tests run only when external triggers exist.

- [ ] **Step 4: Green, parity and commit**

```powershell
pnpm vitest run src/utils/__tests__/grokIntelligenceWorkflowBehavior.test.ts src/utils/__tests__/pluginParity.test.ts src/utils/__tests__/installWorkflows.test.ts
git add -p -- templates/commands templates/engine/strategies plugins/ccg/commands plugins/ccg/skills
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(workflows): route external intelligence across CCG"
```

## Task 10: 增加真实 Windows CI 门禁

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/grok-live-smoke.yml`
- Modify tests where platform guards are required

- [ ] **Step 1: Convert Node and Go jobs to OS matrices**

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest]
    node-version: [20, 22]
runs-on: ${{ matrix.os }}
```

Go uses `os: [ubuntu-latest, windows-latest]`. Coverage upload remains Ubuntu/Node 22 only. Use platform-neutral Go output paths instead of `/dev/null` on Windows.

- [ ] **Step 2: Add Windows-specific offline coverage**

Tests must execute Windows path validation, junction/reparse rejection, exact env, exclusive temp file, process-tree timeout, PowerShell doctor JSON and wrapper argument construction.

- [ ] **Step 3: Keep paid live smoke manual**

`grok-live-smoke.yml` uses `workflow_dispatch`, repository environment approval and secrets; it never runs on push/PR. It runs `doctor --grok-live`, Web/X event validation and public contract verify without uploading raw artifacts.

- [ ] **Step 4: Validate workflow and commit**

```powershell
pnpm test
Push-Location codeagent-wrapper
go test ./...
Pop-Location
git add -p -- .github/workflows/ci.yml
git add -- .github/workflows/grok-live-smoke.yml
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "ci: test Grok intelligence on Windows"
```

## Task 11: 更新文档、版本和分发清单（不发布）

**Files:**

- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `CHANGELOG.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `src/CLAUDE.md`
- Modify: `codeagent-wrapper/CLAUDE.md`
- Modify: `package.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.codex-plugin/marketplace.json`
- Modify: `plugins/ccg/.codex-plugin/plugin.json`
- Test: `src/utils/__tests__/pluginParity.test.ts`
- Test: `src/utils/__tests__/installer.test.ts`

- [ ] **Step 1: Document user-visible boundaries**

Document explicit consent, what is uploaded, possible fees, strict provider arbitration, generic Grok vs intelligence, commands, auto routing, X policy, deep advisory limitation, evidence layout, canonical task item, cache/retention/export, waiver, doctor split and Windows limitations.

- [ ] **Step 2: Update version consistently**

Set all npm/plugin/marketplace versions from local `3.2.2` to `3.3.0`. Keep wrapper protocol at `5.13.0`. Update command counts and changelog for the actual added commands. Do not publish, push or manually upload binary artifacts.

- [ ] **Step 3: Verify package contents and parity**

```powershell
pnpm vitest run src/utils/__tests__/pluginParity.test.ts src/utils/__tests__/installer.test.ts src/utils/__tests__/installWorkflows.test.ts
pnpm pack --dry-run
```

Expected: runtime, fixtures, commands and skills are included; four release versions equal `3.3.0`; no raw local evidence is packed.

- [ ] **Step 4: Commit**

```powershell
git add -p -- README.md README_EN.md CHANGELOG.md AGENTS.md CLAUDE.md src/CLAUDE.md codeagent-wrapper/CLAUDE.md package.json .claude-plugin/marketplace.json .codex-plugin/marketplace.json plugins/ccg/.codex-plugin/plugin.json
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "docs: document Grok external intelligence"
```

## Task 12: 运行全量离线、质量和安全门禁

**Files:**

- Verify only; fix failures in the owning task's files with a focused follow-up commit

- [ ] **Step 1: TypeScript gates**

```powershell
pnpm typecheck
pnpm test -- --coverage
pnpm build
pnpm pack --dry-run
```

- [ ] **Step 2: Go gates**

```powershell
Push-Location codeagent-wrapper
go test ./...
go test -race ./...
go vet ./...
go build .
Pop-Location
```

- [ ] **Step 3: Security-focused checks**

Search for forbidden profile regressions:

```powershell
rg -n -- "always-approve|run_terminal_command|Bash\(|Edit\(|os\.Environ\(\)|allow_provider_fallback\s*=\s*true" codeagent-wrapper templates/engine/tools/grok-intelligence plugins/ccg/skills/ccg-grok-intel
```

Expected: generic backend references may remain documented/tested; no intelligence execution path contains them. Inspect a fake-runner environment dump and prove no unrelated secret names pass.

- [ ] **Step 4: Install/distribution smoke**

Install into a temporary home, run local doctor, both manual commands with fake wrapper, all family behavior tests, canonical evidence validation, export, retention cleanup and uninstall. Confirm template/plugin runtime hashes match.

- [ ] **Step 5: Final staged/unstaged review**

```powershell
git status --short
git log --oneline --decorate -15
git diff --check
git diff
```

Expected: no feature changes remain unstaged, original baseline worktree is untouched, no evidence/temp/output/secret file is tracked.

## Task 13: 运行显式付费 live E2E 和 release-readiness 审查

**Files:**

- Local evidence only under ignored `.codex/ccg/intelligence/`
- Do not commit live raw streams

- [ ] **Step 1: Re-run non-paid local contract checks**

```powershell
pnpm exec tsx src/cli.ts doctor --grok
```

Expected: clean inspect, expected CLI/protocol/model/auth state, no model call.

- [ ] **Step 2: Run explicit Web/X live smoke**

```powershell
pnpm exec tsx src/cli.ts doctor --grok-live
```

Expected: validated built-in Web event and X event, URLs in runtime registry, bounded cost/turns, no MCP/plugin/hook origin, unredacted temp deleted.

- [ ] **Step 3: Run public contract lifecycle**

Use a current public SDK/API contract task:

```text
grok-intel(contract) -> CCG plan intake -> fake/local implementation digest -> grok-verify(diff)
```

Assert cache miss/hit, dependency/diff invalidation, canonical task evidence, manifest/evidence hash validation and GPT Pro prompt provenance. Required path uses single-agent evidence only.

- [ ] **Step 4: Run optional deep advisory smoke**

Only if enabled and available. Assert leader-only visibility fields, advisory-only status and no claim that observed search events equal total server tool usage.

- [ ] **Step 5: Final release readiness**

```powershell
git status --short
git diff main...HEAD --check
git diff --stat main...HEAD
git diff main...HEAD
```

Confirm npm/plugin versions `3.3.0`, wrapper `5.13.0`, all local/CI gates green, no live artifact staged, and no publish/push/release action performed. Present the commit series and residual risks to the user for approval.

---

## 执行顺序摘要

```text
0A independent dirty baseline
0B real Windows CLI contract probe
1  opt-in config + design correction
2  secure Go transport
3  real-event registry/validator
4  isolated runner/snapshot
5  artifacts/cache/canonical evidence
6  manual MVP + doctor split
7  GPT Pro provenance
8  limited opt-in auto routes
9  all workflows
10 Windows CI
11 docs/version
12 offline gates
13 explicit paid live E2E
```

Do not start a later task while the preceding gate is red. The CLI contract, safety profile and consent defaults are release blockers, not follow-up hardening.
