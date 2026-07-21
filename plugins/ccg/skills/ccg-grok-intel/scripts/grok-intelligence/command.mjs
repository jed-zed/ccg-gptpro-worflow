#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportIntelligenceBundle, writeIntelligenceBundle } from './lib/artifacts.mjs'
import { createCacheFingerprint, readCacheEntry, removeCacheEntry, withCacheLock, writeCacheEntry } from './lib/cache.mjs'
import { createIntelligenceDecision } from './lib/router.mjs'
import { getDefaultGrokIntelligencePaths, runIsolatedGrokDiagnostics } from './manage.mjs'
import { runBoundedProcess } from './lib/process.mjs'
import { runGrokIntelligence } from './runner.mjs'

const HELP = `CCG Grok external intelligence runner

Usage:
  command.mjs intel --task <text>|--task-file <file> [--mode discover|contract|incident|landscape]
                    [--depth normal|deep] [--file <relative-path>]...
                    [--force-refresh] [--export <directory>]
  command.mjs verify --task <text> [--plan <file>] [--diff <file>]
                     [--dependency <file>]... [--force-refresh]

Exit codes: 0 valid/skip, 2 required evidence unavailable, 3 unsafe context,
4 consent or configuration missing.`

const CACHE_VERSION = Object.freeze({
  runnerVersion: '1',
  wrapperProtocolVersion: 'acp-jsonrpc-1',
  promptTemplateSha256: createHash('sha256').update('ccg-grok-intelligence-prompt-v1').digest('hex'),
  evidenceSchemaVersion: '2',
  routerPolicyVersion: '1',
  sourceTierPolicyVersion: '1',
  eventNormalizerVersion: '1',
  snapshotPolicyVersion: '1',
})

const CACHE_TTL = Object.freeze({
  incident: 30 * 60 * 1000,
  verify: 2 * 60 * 60 * 1000,
  contract: 72 * 60 * 60 * 1000,
  discover: 7 * 24 * 60 * 60 * 1000,
  landscape: 7 * 24 * 60 * 60 * 1000,
  deep: 7 * 24 * 60 * 60 * 1000,
})

function parseArgs(argv) {
  const output = { files: [], dependencies: [] }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (['forceRefresh'].includes(key)) output[key] = true
    else {
      const next = argv[++index]
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`)
      if (key === 'file') output.files.push(next)
      else if (key === 'dependency') output.dependencies.push(next)
      else output[key] = next
    }
  }
  return output
}

function parseTomlValue(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  const quoted = /^"(.*)"$/.exec(value)
  return quoted ? quoted[1].replace(/\\"/g, '"') : value
}

export function parseIntelligenceToml(content) {
  const match = /^\[intelligence\]\s*$([\s\S]*?)(?=^\[)/m.exec(`${content}\n[__end__]\n`)
  const config = {}
  for (const line of (match?.[1] || '').split(/\r?\n/)) {
    const field = /^([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (field) config[field[1]] = parseTomlValue(field[2])
  }
  return config
}

async function exists(path) {
  try { await access(path); return true }
  catch { return false }
}

async function chooseSnapshotFiles(repoRoot, requested) {
  const output = []
  const candidates = requested.length > 0
    ? requested
    : ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'go.mod', 'Cargo.toml', 'README.md']
  for (const candidate of candidates) {
    const absolute = resolve(repoRoot, candidate)
    const rel = relative(repoRoot, absolute).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Snapshot path escapes the repository: ${candidate}`)
    if (await exists(absolute) && (await stat(absolute)).isFile()) output.push(rel)
  }
  if (output.length === 0) throw new Error('No safe snapshot file was selected; pass --file <relative-path>')
  return [...new Set(output)]
}

async function digestBinding(repoRoot, kind, file) {
  if (!file) return null
  const absolute = resolve(repoRoot, file)
  const rel = relative(repoRoot, absolute).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${kind} path escapes the repository`)
  const bytes = await readFile(absolute)
  return { kind, path: rel, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function countSearches(result, tool) {
  return result.evidence?.normalized?.searches?.filter(search => search.tool === tool && search.status === 'completed').length || 0
}

function reportFor(result, task, bindings) {
  const sources = result.evidence?.registry?.sources || []
  return [
    '# Grok External Intelligence Evidence',
    '',
    `- Task: ${task}`,
    `- Web searches: ${countSearches(result, 'web_search')}`,
    `- X searches: ${countSearches(result, 'x_search')}`,
    `- Bound digests: ${bindings.length}`,
    `- Observed sources: ${sources.length}`,
    '',
    ...sources.map(source => `- [${source.id}] ${source.canonical_url}`),
    '',
  ].join('\n')
}

function resolveContainedRoot(repoRoot, requested, name) {
  const target = resolve(repoRoot, requested)
  const rel = relative(repoRoot, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`${name} must remain inside the repository`)
  return target
}

async function defaultGitState(repoRoot, files) {
  let head = 'unversioned'
  try {
    const result = await runBoundedProcess('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      timeoutMs: 5000,
      maxBytes: 4096,
    })
    if (result.exitCode === 0 && /^[a-f0-9]{40,64}$/i.test(result.stdout.trim()))
      head = result.stdout.trim().toLowerCase()
  }
  catch {}
  const selected = []
  for (const path of [...files].sort()) {
    const bytes = await readFile(resolve(repoRoot, path))
    selected.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return {
    head,
    dirtyDigest: createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
  }
}

function ttlFor(action, mode) {
  return action === 'verify' ? CACHE_TTL.verify : (CACHE_TTL[mode] || CACHE_TTL.discover)
}

async function cachedArtifactsMatch(repoRoot, result) {
  if (!result || result.status !== 'valid')
    return false
  for (const [pathField, hashField] of [['evidencePath', 'evidenceSha256'], ['manifestPath', 'manifestSha256']]) {
    const file = result[pathField]
    const expected = result[hashField]
    if (typeof file !== 'string' || !/^[a-f0-9]{64}$/.test(String(expected || '')))
      return false
    const absolute = resolve(repoRoot, file)
    const rel = relative(repoRoot, absolute)
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      return false
    try {
      const actual = createHash('sha256').update(await readFile(absolute)).digest('hex')
      if (actual !== expected)
        return false
    }
    catch {
      return false
    }
  }
  return true
}

async function exportCachedResult({ repoRoot, options, result }) {
  if (!options.export)
    return result
  const manifestPath = resolve(repoRoot, result.manifestPath)
  const evidenceId = basename(dirname(manifestPath))
  const exported = await exportIntelligenceBundle({
    bundleDir: dirname(manifestPath),
    exportRoot: resolve(options.export),
    evidenceId,
    secrets: [process.env.XAI_API_KEY],
  })
  return { ...result, exported }
}

export async function runManualCommand(action, options, runtime = {}) {
  if (!['intel', 'verify'].includes(action)) throw new Error('Action must be intel or verify')
  if (typeof options.task !== 'string' || !options.task.trim()) throw new Error('--task is required')
  const repoRoot = resolve(runtime.repoRoot || process.cwd())
  const configPath = resolve(options.config || runtime.configPath || resolve(homedir(), '.claude', '.ccg', 'config.toml'))
  const config = parseIntelligenceToml(await readFile(configPath, 'utf8'))
  const mode = action === 'verify' ? 'contract' : (options.mode || 'discover')
  if (!['discover', 'contract', 'incident', 'landscape'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`)
  const depth = options.depth || 'normal'
  if (!['normal', 'deep'].includes(depth)) throw new Error(`Unsupported depth: ${depth}`)
  if (depth === 'deep' && config.deep_research_enabled !== true) throw new Error('Deep research is disabled in CCG configuration')
  const bindings = (await Promise.all([
    digestBinding(repoRoot, 'plan', options.plan),
    digestBinding(repoRoot, 'diff', options.diff),
    ...(options.dependencies || []).map(file => digestBinding(repoRoot, 'dependency', file)),
  ])).filter(Boolean)
  const files = await chooseSnapshotFiles(repoRoot, [...(options.files || []), ...bindings.map(item => item.path)])
  const paths = runtime.paths || getDefaultGrokIntelligencePaths()
  const requirement = 'required'
  const task = bindings.length > 0
    ? `${options.task.trim()}\n\nBound input digests:\n${bindings.map(item => `${item.kind}:${item.path}:${item.sha256}`).join('\n')}`
    : options.task.trim()
  if (config.enabled !== true) {
    return {
      exitCode: 4,
      status: 'configuration_required',
      reason: 'External intelligence requires explicit user consent and enabled configuration',
      requirement,
      mode,
      depth,
      bindings,
    }
  }

  const sourceEnv = runtime.sourceEnv || process.env
  const apiKey = config.auth_mode === 'api_key' ? sourceEnv.XAI_API_KEY : undefined
  const authentication = { authMode: config.auth_mode || 'browser_oauth', apiKey }
  const diagnosticProbe = await (runtime.runDiagnostics || runIsolatedGrokDiagnostics)({
    paths,
    authentication,
    command: runtime.command || 'grok',
    prefixArgs: runtime.prefixArgs || [],
    sourceEnv,
  })
  const diagnostics = diagnosticProbe.diagnostics || diagnosticProbe
  if (diagnostics.safe !== true || typeof diagnostics.version !== 'string' || !diagnostics.version.trim())
    throw new Error('Grok diagnostics did not return a safe versioned contract')
  const gitState = await (runtime.gitState || defaultGitState)(repoRoot, files)
  if (typeof gitState?.head !== 'string' || !gitState.head || typeof gitState?.dirtyDigest !== 'string' || !gitState.dirtyDigest)
    throw new Error('Manual cache requires a valid repository state digest')
  const effectiveMode = depth === 'deep' ? 'deep' : mode
  const fingerprint = createCacheFingerprint({
    task,
    mode: effectiveMode,
    searchPolicy: {
      action,
      require_web_search: config.require_web_search !== false,
      x_search_policy: config.x_search_policy || 'preferred',
    },
    model: config.default_model || 'grok-4.5',
    gitHead: gitState.head,
    dirtyDigest: gitState.dirtyDigest,
    planDigest: bindings.find(item => item.kind === 'plan')?.sha256 || 'none',
    diffDigest: bindings.find(item => item.kind === 'diff')?.sha256 || 'none',
    lockfiles: bindings.filter(item => item.kind === 'dependency').map(item => ({ path: item.path, sha256: item.sha256 })),
    targetVersions: {},
    targetDomains: [],
    cliVersion: diagnostics.version.trim(),
    ...CACHE_VERSION,
  })
  const artifactRoot = resolveContainedRoot(repoRoot, String(config.artifact_root || '.codex/ccg/intelligence'), 'Artifact root')
  const cacheRoot = resolveContainedRoot(artifactRoot, runtime.cacheRoot || resolve(artifactRoot, '.cache'), 'Cache root')
  const now = runtime.clock ? runtime.clock() : new Date()

  return withCacheLock({ cacheRoot, key: fingerprint.key, clock: () => now }, async () => {
    let cached = await readCacheEntry({
      cacheRoot,
      fingerprint: fingerprint.key,
      now,
      ttlMs: ttlFor(action, effectiveMode),
      forceRefresh: options.forceRefresh === true,
    })
    if (cached.hit && await cachedArtifactsMatch(repoRoot, cached.entry.result)) {
      const hit = { ...cached.entry.result, cache: { hit: true, reason: cached.reason, fingerprint: fingerprint.key } }
      return exportCachedResult({ repoRoot, options, result: hit })
    }
    if (cached.hit)
      cached = { hit: false, reason: 'artifact_mismatch' }
    const cacheState = { hit: false, reason: cached.reason, fingerprint: fingerprint.key }
    const result = await (runtime.runner || runGrokIntelligence)({
      requirement,
      consent: true,
      config,
      task,
      mode: effectiveMode,
      repoRoot,
      selectedPaths: files,
      dirtyDiffs: [],
      tempParent: paths.tempParent,
      grokHome: paths.grokHome,
      sourceEnv,
      apiKey,
      command: runtime.command,
      prefixArgs: runtime.prefixArgs,
      runDiagnostics: async () => diagnostics,
    })
    if (result.exitCode !== 0 || result.status !== 'valid')
      return { ...result, requirement, mode, depth, bindings, cache: cacheState }

    const createdAt = (runtime.clock ? runtime.clock() : new Date()).toISOString()
    const evidenceId = `${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${createHash('sha256').update(`${task}\n${createdAt}`).digest('hex').slice(0, 12)}`
    const decision = createIntelligenceDecision({
      requirement,
      status: 'valid',
      mode: effectiveMode,
      reason: action === 'verify' ? 'External facts verified against bound input digests' : 'External intelligence collected',
      created_at: createdAt,
      ...(depth === 'deep' ? { deepVisibility: {
        evidence_visibility: 'leader_only', observed_web_search_events: countSearches(result, 'web_search'),
        observed_x_search_events: countSearches(result, 'x_search'), total_server_tool_usage: null, advisory_only: true,
      } } : {}),
    })
    const bundle = await writeIntelligenceBundle({
      projectRoot: repoRoot,
      artifactRoot,
      evidenceId,
      decision,
      evidence: { ...result.evidence, bindings, action, force_refresh: options.forceRefresh === true, cache: cacheState },
      report: reportFor(result, options.task.trim(), bindings),
      rawEvents: result.raw?.notifications || [],
      secrets: [apiKey],
      clock: () => new Date(createdAt),
    })
    let exported = null
    if (options.export) {
      exported = await exportIntelligenceBundle({
        bundleDir: bundle.directory,
        exportRoot: resolve(options.export),
        evidenceId,
        secrets: [apiKey],
      })
    }
    const commandResult = {
      exitCode: 0, status: 'valid', requirement, mode, depth, bindings,
      webSearches: countSearches(result, 'web_search'), xSearches: countSearches(result, 'x_search'),
      evidencePath: bundle.artifactRelativePath, evidenceSha256: bundle.artifactSha256,
      manifestPath: bundle.manifestRelativePath, manifestSha256: bundle.manifestSha256,
      exported,
      cache: cacheState,
    }
    await removeCacheEntry({ cacheRoot, fingerprint: fingerprint.key })
    await writeCacheEntry({
      cacheRoot,
      fingerprint: fingerprint.key,
      entry: {
        fingerprint: fingerprint.key,
        created_at: createdAt,
        status: 'valid',
        degraded: false,
        failed: false,
        evidence: { claims: result.evidence?.claims || [] },
        result: { ...commandResult, exported: null },
      },
    })
    return commandResult
  })
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  const action = argv[0]
  const options = parseArgs(argv.slice(1))
  if (options.taskFile) options.task = await readFile(resolve(options.taskFile), 'utf8')
  const result = await runManualCommand(action, options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.exitCode
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 4
  })
}
