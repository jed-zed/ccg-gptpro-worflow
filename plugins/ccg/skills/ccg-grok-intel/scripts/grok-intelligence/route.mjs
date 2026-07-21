#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseIntelligenceToml, runManualCommand } from './command.mjs'
import {
  createCanonicalEvidenceItem,
  createIntelligenceDecision,
  createTaskIntelligencePointer,
} from './lib/router.mjs'
import { resolveEffectiveXPolicy } from './lib/validator.mjs'

const INITIAL_MODES = new Set(['contract', 'incident'])
const REQUIREMENTS = new Set(['required', 'preferred', 'disabled'])
const CONTRACT_PATTERN = /(?:\b(?:api|sdk|dependency|package|library|protocol|cloud|database|cve|advisory|authentication|cryptograph\w*|regulation|standard|deprecat\w*|compatib\w*|version|upgrade)\b|依赖|接口|协议|升级|弃用|兼容|漏洞|安全公告|认证|加密|法规|标准)/i
const INCIDENT_PATTERN = /(?:\b(?:incident|outage|downtime|service\s+status|regression|regional\s+errors?|production\s+failure)\b|事故|宕机|服务状态|线上故障|区域错误|新回归)/i
const CURRENT_PATTERN = /(?:\b(?:current|latest|recent|today|now|newly)\b|当前|最新|最近|今天|刚刚|新发布)/i

function emit(runtime, event) {
  runtime.onEvent?.(event)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function relativeInside(root, target, label) {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(resolvedRoot, target)
  const rel = relative(resolvedRoot, resolvedTarget).replace(/\\/g, '/')
  if (!rel || rel.startsWith('../') || isAbsolute(rel))
    throw new Error(`${label} must stay inside the repository`)
  return { absolute: resolvedTarget, relative: rel }
}

async function assertNoLinkedPath(root, target, label, { allowMissing = false } = {}) {
  if (resolve(root) === resolve(target))
    return { absolute: resolve(root), relative: '' }
  const path = relativeInside(root, target, label)
  let current = resolve(root)
  for (const segment of path.relative.split('/')) {
    current = resolve(current, segment)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink())
        throw new Error(`${label} must not traverse a link or junction: ${path.relative}`)
    }
    catch (error) {
      if (allowMissing && error?.code === 'ENOENT')
        break
      throw error
    }
  }
  return path
}

async function digestBinding(repoRoot, label, value) {
  if (!value)
    return null
  const path = await assertNoLinkedPath(repoRoot, value, label)
  const metadata = await stat(path.absolute)
  if (!metadata.isFile())
    throw new Error(`${label} must be a regular file: ${path.relative}`)
  const bytes = await readFile(path.absolute)
  return { path: path.relative, sha256: sha256(bytes), bytes: bytes.length }
}

async function collectBindings(input, repoRoot) {
  return {
    task: { sha256: sha256(input.task.trim()), chars: input.task.trim().length },
    target: await digestBinding(repoRoot, 'target', input.target),
    plan: await digestBinding(repoRoot, 'plan', input.plan),
    diff: await digestBinding(repoRoot, 'diff', input.diff),
    dependencies: await Promise.all((input.dependencies || []).map(file => digestBinding(repoRoot, 'dependency', file))),
  }
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    if (error?.code === 'ENOENT')
      return null
    throw error
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function resolveActiveTaskDir(input, repoRoot, statePath) {
  const candidate = input.taskDir
    ? relativeInside(repoRoot, input.taskDir, 'task directory').absolute
    : dirname(statePath)
  const tasksRoot = resolve(repoRoot, '.ccg', 'tasks')
  const taskRelative = relative(tasksRoot, candidate).replace(/\\/g, '/')
  if (!taskRelative || taskRelative.startsWith('../') || taskRelative.includes('/'))
    return null
  return candidate
}

async function validateSuccessfulBundle(repoRoot, routeDecision, result) {
  const artifact = await assertNoLinkedPath(repoRoot, result.evidencePath, 'evidence artifact')
  const manifest = await assertNoLinkedPath(repoRoot, result.manifestPath, 'evidence manifest')
  if (dirname(artifact.absolute) !== dirname(manifest.absolute))
    throw new Error('Evidence artifact and manifest must share one bundle directory')
  const [artifactBytes, manifestBytes] = await Promise.all([
    readFile(artifact.absolute),
    readFile(manifest.absolute),
  ])
  if (sha256(artifactBytes) !== result.evidenceSha256)
    throw new Error('Automatic route evidence artifact hash mismatch')
  if (sha256(manifestBytes) !== result.manifestSha256)
    throw new Error('Automatic route evidence manifest hash mismatch')
  let artifactJson
  let manifestJson
  try {
    artifactJson = JSON.parse(artifactBytes)
    manifestJson = JSON.parse(manifestBytes)
  }
  catch (error) {
    throw new Error(`Automatic route bundle JSON is malformed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const evidenceId = String(manifestJson.evidenceId || '')
  if (!evidenceId || evidenceId !== dirname(artifact.absolute).split(/[\\/]/).at(-1))
    throw new Error('Automatic route manifest evidenceId does not match its bundle directory')
  if (manifestJson.localOnly !== true || manifestJson.exported !== false)
    throw new Error('Automatic route evidence must remain local-only and unexported')
  const boundArtifact = manifestJson.files?.['evidence.json']
  if (boundArtifact?.sha256 !== result.evidenceSha256 || boundArtifact?.bytes !== artifactBytes.length)
    throw new Error('Automatic route manifest does not bind evidence.json bytes')
  const decision = createIntelligenceDecision(artifactJson.decision)
  if (decision.requirement !== routeDecision.requirement || decision.status !== 'valid')
    throw new Error('Automatic route bundle decision does not match the required route')
  return {
    evidenceId,
    decision,
    bundle: {
      artifactRelativePath: artifact.relative,
      artifactSha256: result.evidenceSha256,
      manifestRelativePath: manifest.relative,
      manifestSha256: result.manifestSha256,
    },
  }
}

async function publishCanonicalEvidence({ input, repoRoot, statePath, routeDecision, result }) {
  const taskDir = resolveActiveTaskDir(input, repoRoot, statePath)
  if (!taskDir)
    return null
  const taskFile = resolve(taskDir, 'task.json')
  const task = await readJsonIfPresent(taskFile)
  if (!task) {
    if (input.taskDir)
      throw new Error('Explicit task directory is missing task.json')
    return null
  }
  const validated = await validateSuccessfulBundle(repoRoot, routeDecision, result)
  const item = createCanonicalEvidenceItem({
    evidenceId: validated.evidenceId,
    decision: validated.decision,
    bundle: validated.bundle,
    summary: validated.decision.reason,
  })
  const evidenceFile = resolve(taskDir, 'evidence.json')
  const existing = await readJsonIfPresent(evidenceFile) || { schemaVersion: 1, items: [] }
  if (!Array.isArray(existing.items))
    throw new Error('Canonical task evidence.json has no items array')
  existing.items = [
    ...existing.items.filter(entry => entry?.provider !== 'grok' || entry?.role !== 'external-intelligence'),
    item,
  ]
  task.intelligence = createTaskIntelligencePointer({
    evidenceId: validated.evidenceId,
    decision: validated.decision,
    bundle: validated.bundle,
  })
  await writeState(evidenceFile, existing)
  await writeState(taskFile, task)
  return {
    evidence_id: validated.evidenceId,
    artifact_file: validated.bundle.artifactRelativePath,
    artifact_sha256: validated.bundle.artifactSha256,
    manifest_file: validated.bundle.manifestRelativePath,
    manifest_sha256: validated.bundle.manifestSha256,
  }
}

async function resolveConfig(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'config'))
    return input.config
  if (!input.configPath)
    return undefined
  try {
    return parseIntelligenceToml(await readFile(resolve(input.configPath), 'utf8'))
  }
  catch (error) {
    if (error?.code === 'ENOENT')
      return undefined
    throw error
  }
}

function skippedDecision(reason, trigger = 'configuration_disabled') {
  return {
    enabled: false,
    requirement: 'disabled',
    mode: 'contract',
    trigger,
    reason,
    status: 'skipped',
    require_web_search: false,
    configured_x_policy: 'disabled',
    effective_x_policy: 'disabled',
  }
}

function inheritedRequirement(input, previous) {
  const value = input.inheritedRequirement || previous?.decision?.requirement
  return REQUIREMENTS.has(value) ? value : null
}

function classifyFinalVerification(input, task, previous) {
  const inherited = inheritedRequirement(input, previous)
  const reEvaluated = INCIDENT_PATTERN.test(task) && CURRENT_PATTERN.test(task)
    ? 'required'
    : (CONTRACT_PATTERN.test(task) ? 'required' : null)
  const requirement = inherited && inherited !== 'disabled' ? inherited : reEvaluated
  if (!requirement)
    return skippedDecision('Final verification found no inherited or re-evaluated external-intelligence requirement.', 'final_verify_not_required')
  return {
    requirement,
    mode: 'verify',
    trigger: 'final_diff_verify',
    reason: 'Final external verification inherited or re-evaluated the prior intelligence requirement.',
  }
}

function classifySemanticRoute(input) {
  if (!INITIAL_MODES.has(input.semanticMode))
    return null
  const reason = String(input.semanticReason || '').trim()
  if (!reason)
    throw new Error('A semantic intelligence route requires --semantic-reason')
  return { requirement: 'required', mode: input.semanticMode, trigger: 'codex_semantic_judgment', reason }
}

function classifyHardTrigger(task) {
  if (INCIDENT_PATTERN.test(task) && CURRENT_PATTERN.test(task)) {
    return {
      requirement: 'required',
      mode: 'incident',
      trigger: 'current_incident',
      reason: 'A current external incident requires source-backed service and release evidence.',
    }
  }
  if (CONTRACT_PATTERN.test(task)) {
    return {
      requirement: 'required',
      mode: 'contract',
      trigger: 'dependency_api_contract',
      reason: 'A dependency or external API contract requires current source-backed evidence.',
    }
  }
  return skippedDecision('No initial automatic external-intelligence trigger matched this task class.', 'no_initial_trigger')
}

function decorateActiveDecision(route, config, task) {
  if (route.requirement === 'disabled')
    return route

  const configuredXPolicy = config.x_search_policy || 'preferred'
  const policyMode = route.mode === 'verify' && INCIDENT_PATTERN.test(task) && CURRENT_PATTERN.test(task)
    ? 'incident'
    : route.mode
  return {
    enabled: true,
    ...route,
    status: 'pending',
    require_web_search: config.require_web_search !== false,
    configured_x_policy: configuredXPolicy,
    effective_x_policy: resolveEffectiveXPolicy(configuredXPolicy, policyMode),
  }
}

export function classifyWorkflowRoute(input, config, previous = null) {
  if (!config || config.enabled !== true)
    return skippedDecision('External intelligence automatic routing is disabled because configuration or explicit opt-in is missing.')
  if (config.auto_route !== true)
    return skippedDecision('External intelligence is enabled, but automatic routing is disabled by configuration.')
  const task = String(input.task || '').trim()
  if (!task)
    throw new Error('Automatic intelligence routing requires a non-empty task')
  const route = input.trigger === 'final_diff_verify'
    ? classifyFinalVerification(input, task, previous)
    : (classifySemanticRoute(input) || classifyHardTrigger(task))
  return decorateActiveDecision(route, config, task)
}

export function buildRouteCommandArgv(decision, input) {
  const action = decision.mode === 'verify' ? 'verify' : 'intel'
  const argv = [action, '--task', input.task.trim()]
  if (action === 'intel')
    argv.push('--mode', decision.mode)
  if (input.plan)
    argv.push('--plan', input.plan)
  if (input.diff)
    argv.push('--diff', input.diff)
  for (const dependency of input.dependencies || [])
    argv.push('--dependency', dependency)
  if (input.forceRefresh === true)
    argv.push('--force-refresh')
  return argv
}

function commandOptions(input, decision, config) {
  return {
    task: input.task.trim(),
    ...(decision.mode !== 'verify' ? { mode: decision.mode } : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.diff ? { diff: input.diff } : {}),
    dependencies: [...(input.dependencies || [])],
    forceRefresh: input.forceRefresh === true,
    config,
  }
}

async function defaultInvoke(request) {
  if (!request.configPath)
    return { exitCode: 4, status: 'configuration_required', reason: 'Automatic route has no readable CCG config path.' }
  const options = { ...request.options, config: request.configPath }
  return runManualCommand(request.action, options, { repoRoot: request.repoRoot, configPath: request.configPath })
}

function makeState({ input, bindings, decision, execution, inputDigest }) {
  return {
    schemaVersion: 1,
    workflow: input.workflow,
    phase: input.phase,
    task: input.task.trim().slice(0, 500),
    input_digest: inputDigest,
    bindings,
    decision,
    execution,
    updated_at: new Date().toISOString(),
  }
}

function routeInputDigest(input, decision, bindings) {
  return sha256(stableJson({
    workflow: input.workflow,
    phase: input.phase,
    decision: {
      requirement: decision.requirement,
      mode: decision.mode,
      trigger: decision.trigger,
      require_web_search: decision.require_web_search,
      configured_x_policy: decision.configured_x_policy,
      effective_x_policy: decision.effective_x_policy,
    },
    bindings,
  }))
}

async function prepareWorkflowRoute(input, runtime) {
  const repoRoot = await realpath(resolve(input.repoRoot || process.cwd()))
  const metadata = await stat(repoRoot)
  if (!metadata.isDirectory())
    throw new Error('repoRoot must be a directory')
  if (!input.stateFile)
    throw new Error('Automatic intelligence routing requires --state-file')
  const statePath = relativeInside(repoRoot, input.stateFile, 'state file').absolute
  await assertNoLinkedPath(repoRoot, dirname(statePath), 'state directory', { allowMissing: true })
  const previous = await readJsonIfPresent(statePath)
  const config = await resolveConfig(input)
  const decision = classifyWorkflowRoute(input, config, previous)
  emit(runtime, 'decision')
  const bindings = await collectBindings({ ...input, task: String(input.task || '') }, repoRoot)
  const inputDigest = routeInputDigest(input, decision, bindings)
  return { repoRoot, statePath, previous, config, decision, bindings, inputDigest }
}

async function completeSkippedRoute(input, context, runtime) {
  const state = makeState({
    input,
    bindings: context.bindings,
    decision: context.decision,
    inputDigest: context.inputDigest,
    execution: { status: 'skipped', exit_code: 0, invoked: false },
  })
  await writeState(context.statePath, state)
  emit(runtime, 'state:complete')
  return { exitCode: 0, invoked: false, reused: false, ...state }
}

function reusableRoute(context) {
  return context.previous?.input_digest === context.inputDigest
    && context.previous?.decision?.status === 'valid'
    && context.previous?.execution?.exit_code === 0
}

async function invokeRouteRunner(input, context, runtime) {
  const action = context.decision.mode === 'verify' ? 'verify' : 'intel'
  const argv = buildRouteCommandArgv(context.decision, input)
  const pendingState = makeState({
    input,
    bindings: context.bindings,
    decision: context.decision,
    inputDigest: context.inputDigest,
    execution: { status: 'pending', exit_code: null, invoked: true, action, argv },
  })
  await writeState(context.statePath, pendingState)
  emit(runtime, 'state:pending')
  const invoke = runtime.invoke || defaultInvoke
  const result = await invoke({
    action,
    argv,
    options: commandOptions(input, context.decision, context.config),
    repoRoot: context.repoRoot,
    configPath: input.configPath ? resolve(input.configPath) : '',
    stateFile: context.statePath,
  })
  return { action, argv, result }
}

async function canonicalizeRunnerResult(input, context, result) {
  let canonicalEvidence = null
  if (result?.exitCode === 0 && result?.status === 'valid' && result?.evidencePath) {
    try {
      canonicalEvidence = await publishCanonicalEvidence({
        input,
        repoRoot: context.repoRoot,
        statePath: context.statePath,
        routeDecision: context.decision,
        result,
      })
    }
    catch (error) {
      return {
        result: {
          exitCode: 3,
          status: 'unsafe_context',
          reason: error instanceof Error ? error.message : String(error),
        },
        canonicalEvidence: null,
      }
    }
  }
  return { result, canonicalEvidence }
}

async function completeInvokedRoute(input, context, invocation, runtime) {
  const published = await canonicalizeRunnerResult(input, context, invocation.result)
  const result = published.result
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 4
  const finalDecision = {
    ...context.decision,
    status: exitCode === 0 && result?.status === 'valid' ? 'valid' : 'blocked',
  }
  const finalState = makeState({
    input,
    bindings: context.bindings,
    decision: finalDecision,
    inputDigest: context.inputDigest,
    execution: {
      status: String(result?.status || 'configuration_required'),
      exit_code: exitCode,
      invoked: true,
      action: invocation.action,
      argv: invocation.argv,
      ...(result?.reason ? { reason: String(result.reason) } : {}),
      ...(result?.evidencePath ? {
        evidence_path: result.evidencePath,
        evidence_sha256: result.evidenceSha256,
        manifest_path: result.manifestPath,
        manifest_sha256: result.manifestSha256,
      } : {}),
    },
  })
  if (published.canonicalEvidence)
    finalState.canonical_evidence = published.canonicalEvidence
  await writeState(context.statePath, finalState)
  emit(runtime, 'state:complete')
  return { exitCode, invoked: true, reused: false, ...finalState }
}

export async function runWorkflowRoute(input, runtime = {}) {
  const context = await prepareWorkflowRoute(input, runtime)
  if (context.decision.requirement === 'disabled')
    return completeSkippedRoute(input, context, runtime)
  if (reusableRoute(context))
    return { exitCode: 0, invoked: false, reused: true, ...context.previous }
  const invocation = await invokeRouteRunner(input, context, runtime)
  return completeInvokedRoute(input, context, invocation, runtime)
}

function parseArgs(argv) {
  const output = { dependencies: [] }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('--'))
      continue
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (key === 'forceRefresh') {
      output.forceRefresh = true
      continue
    }
    const next = argv[++index]
    if (!next || next.startsWith('--'))
      throw new Error(`Missing value for ${value}`)
    if (key === 'dependency')
      output.dependencies.push(next)
    else
      output[key] = next
  }
  return output
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const repoRoot = resolve(args.repoRoot || process.cwd())
  const configPath = resolve(args.config || resolve(homedir(), '.claude', '.ccg', 'config.toml'))
  const taskFile = args.taskFile ? await assertNoLinkedPath(repoRoot, args.taskFile, 'task file') : null
  const task = taskFile ? await readFile(taskFile.absolute, 'utf8') : String(args.task || '')
  const result = await runWorkflowRoute({
    repoRoot,
    configPath,
    workflow: args.workflow || 'unknown',
    phase: args.phase || 'intake',
    task,
    stateFile: args.stateFile,
    trigger: args.trigger,
    semanticMode: args.semanticMode,
    semanticReason: args.semanticReason,
    inheritedRequirement: args.inheritedRequirement,
    plan: args.plan,
    diff: args.diff,
    dependencies: args.dependencies,
    forceRefresh: args.forceRefresh === true,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.exitCode
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 4
  })
}
