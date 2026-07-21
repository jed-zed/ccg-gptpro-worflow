#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exportIntelligenceBundle, writeIntelligenceBundle } from './lib/artifacts.mjs'
import { createIntelligenceDecision } from './lib/router.mjs'
import { getDefaultGrokIntelligencePaths } from './manage.mjs'
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
  const result = await (runtime.runner || runGrokIntelligence)({
    requirement,
    consent: config.enabled === true,
    config,
    task,
    mode: depth === 'deep' ? 'deep' : mode,
    repoRoot,
    selectedPaths: files,
    dirtyDiffs: [],
    tempParent: paths.tempParent,
    grokHome: paths.grokHome,
    sourceEnv: process.env,
    apiKey: config.auth_mode === 'api_key' ? process.env.XAI_API_KEY : undefined,
  })
  if (result.exitCode !== 0 || result.status !== 'valid') return { ...result, requirement, mode, depth, bindings }

  const createdAt = new Date().toISOString()
  const evidenceId = `${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${createHash('sha256').update(`${task}\n${createdAt}`).digest('hex').slice(0, 12)}`
  const decision = createIntelligenceDecision({
    requirement,
    status: 'valid',
    mode: depth === 'deep' ? 'deep' : mode,
    reason: action === 'verify' ? 'External facts verified against bound input digests' : 'External intelligence collected',
    created_at: createdAt,
    ...(depth === 'deep' ? { deepVisibility: {
      evidence_visibility: 'leader_only', observed_web_search_events: countSearches(result, 'web_search'),
      observed_x_search_events: countSearches(result, 'x_search'), total_server_tool_usage: null, advisory_only: true,
    } } : {}),
  })
  const bundle = await writeIntelligenceBundle({
    projectRoot: repoRoot,
    artifactRoot: resolve(repoRoot, String(config.artifact_root || '.codex/ccg/intelligence')),
    evidenceId,
    decision,
    evidence: { ...result.evidence, bindings, action, force_refresh: options.forceRefresh === true },
    report: reportFor(result, options.task.trim(), bindings),
    rawEvents: result.raw?.notifications || [],
    secrets: [process.env.XAI_API_KEY],
  })
  let exported = null
  if (options.export) {
    exported = await exportIntelligenceBundle({
      bundleDir: bundle.directory,
      exportRoot: resolve(options.export),
      evidenceId,
      secrets: [process.env.XAI_API_KEY],
    })
  }
  return {
    exitCode: 0, status: 'valid', requirement, mode, depth, bindings,
    webSearches: countSearches(result, 'web_search'), xSearches: countSearches(result, 'x_search'),
    evidencePath: bundle.artifactRelativePath, evidenceSha256: bundle.artifactSha256,
    manifestPath: bundle.manifestRelativePath, manifestSha256: bundle.manifestSha256,
    exported,
  }
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
