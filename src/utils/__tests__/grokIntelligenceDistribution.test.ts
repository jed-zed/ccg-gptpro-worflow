import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs-extra'
import { getCoreCommandIds, installWorkflows } from '../installer'
// @ts-expect-error Runtime is intentionally shipped as dependency-free ESM.
import { defaultGitState, parseIntelligenceToml, runManualCommand } from '../../../templates/engine/tools/grok-intelligence/command.mjs'
// @ts-expect-error Runtime is intentionally shipped as dependency-free ESM.
import * as grokManage from '../../../templates/engine/tools/grok-intelligence/manage.mjs'

const { ensureDedicatedGrokHome, getDefaultGrokIntelligencePaths, resolveDoctorAuthentication } = grokManage

const ROOT = process.cwd()
const TEMPLATE_RUNTIME = join(ROOT, 'templates', 'engine', 'tools', 'grok-intelligence')
const PLUGIN_RUNTIME = join(ROOT, 'plugins', 'ccg', 'skills', 'ccg-grok-intel', 'scripts', 'grok-intelligence')

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}

describe('Grok intelligence distribution', () => {
  const installDir = join(tmpdir(), `ccg-grok-distribution-${Date.now()}`)

  afterAll(async () => fs.remove(installDir), 60_000)

  it('registers both manual commands as core workflows', () => {
    expect(getCoreCommandIds()).toEqual(expect.arrayContaining(['grok-intel', 'grok-verify']))
  })

  it('parses only the intelligence config and isolates the Windows credential home', () => {
    expect(parseIntelligenceToml('[general]\nversion="1"\n\n[intelligence]\nenabled = true\ntransport = "acp"\nmax_retries = 2\n'))
      .toMatchObject({ enabled: true, transport: 'acp', max_retries: 2 })
    expect(getDefaultGrokIntelligencePaths({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\PrivateData' },
      userHome: 'C:\\Users\\test',
    }).grokHome).toBe('C:\\PrivateData\\CCG\\grok-intelligence\\grok-home')
  })

  it('rejects invalid pinned runtime configuration instead of silently falling back', () => {
    expect(() => parseIntelligenceToml('[intelligence]\ntransport = "stdio"\n')).toThrow(/transport/i)
    expect(() => parseIntelligenceToml('[intelligence]\nauth_mode = "typo"\n')).toThrow(/auth_mode/i)
    expect(() => parseIntelligenceToml('[intelligence]\nallow_provider_fallback = true\n')).toThrow(/fallback/i)
    expect(() => parseIntelligenceToml('[intelligence]\ndeep_research_enabled = true\ndeep_research_model = ""\n')).toThrow(/deep_research_model/i)
  })

  it('uses an explicit API key for headless doctor runs and preserves browser OAuth otherwise', () => {
    expect(resolveDoctorAuthentication({
      env: { XAI_API_KEY: 'xai-ci-secret' },
      loggedIn: false,
    })).toEqual({ authMode: 'api_key', apiKey: 'xai-ci-secret' })
    expect(resolveDoctorAuthentication({ env: {}, loggedIn: true }))
      .toEqual({ authMode: 'browser_oauth', apiKey: undefined })
    expect(() => resolveDoctorAuthentication({ env: {}, loggedIn: false }))
      .toThrow(/login|XAI_API_KEY/i)
  })

  it('ships strict command and skill surfaces without legacy MCP or unresolved variables', () => {
    const surfaces = [
      'templates/commands/grok-intel.md',
      'templates/commands/grok-verify.md',
      'plugins/ccg/commands/grok-intel.md',
      'plugins/ccg/commands/grok-verify.md',
      'plugins/ccg/skills/ccg-grok-intel/SKILL.md',
      'plugins/ccg/skills/ccg-grok-verify/SKILL.md',
    ]
    for (const surface of surfaces) {
      const content = readFileSync(join(ROOT, surface), 'utf8')
      expect(content, surface).not.toMatch(/mcp__grok[-_]search/i)
      expect(content, surface).not.toMatch(/\{\{[^}]+\}\}/)
    }
    const intel = readFileSync(join(ROOT, surfaces[0]), 'utf8')
    expect(intel).toMatch(/--mode/)
    expect(intel).toMatch(/--depth/)
    expect(intel).toMatch(/--force-refresh/)
    expect(intel).toMatch(/--export/)
    expect(intel).toMatch(/single-agent/i)
    const verify = readFileSync(join(ROOT, surfaces[1]), 'utf8')
    expect(verify).toMatch(/plan.*digest|digest.*plan/i)
    expect(verify).toMatch(/diff.*digest|digest.*diff/i)
    expect(verify).toMatch(/dependenc.*digest|digest.*dependenc/i)
    for (const code of [2, 3, 4]) {
      expect(`${intel}\n${verify}`).toContain(`exit ${code}`)
    }
  })

  it('keeps every shared runtime and fixture byte-identical', () => {
    const templateFiles = collectFiles(TEMPLATE_RUNTIME).map(path => relative(TEMPLATE_RUNTIME, path)).sort()
    const pluginFiles = collectFiles(PLUGIN_RUNTIME).map(path => relative(PLUGIN_RUNTIME, path)).sort()
    expect(pluginFiles).toEqual(templateFiles)
    for (const file of templateFiles)
      expect(readFileSync(join(PLUGIN_RUNTIME, file)), file).toEqual(readFileSync(join(TEMPLATE_RUNTIME, file)))
  })

  it('installs an executable Node runtime with both manual commands', async () => {
    const result = await installWorkflows(getCoreCommandIds(), installDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)
    for (const command of ['grok-intel', 'grok-verify'])
      expect(statSync(join(installDir, 'commands', 'ccg', `${command}.md`)).isFile()).toBe(true)
    const manager = join(installDir, '.ccg', 'engine', 'tools', 'grok-intelligence', 'manage.mjs')
    expect(execFileSync(process.execPath, [manager, '--help'], { encoding: 'utf8' })).toContain('login')
  }, 20_000)

  it('binds verify inputs and persists canonical output through the shared runner', async () => {
    const root = join(tmpdir(), `ccg-grok-manual-${Date.now()}`)
    await fs.ensureDir(root)
    await Promise.all([
      fs.writeFile(join(root, 'config.toml'), '[intelligence]\nenabled = true\nauth_mode = "browser_oauth"\nartifact_root = ".codex/ccg/intelligence"\n'),
      fs.writeFile(join(root, 'package.json'), '{}\n'),
      fs.writeFile(join(root, 'plan.md'), '# Plan\n'),
      fs.writeFile(join(root, 'change.diff'), '+current contract\n'),
      fs.writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'),
    ])
    try {
      let runnerOptions: any
      const result = await runManualCommand('verify', {
        task: 'Verify current API support.',
        config: join(root, 'config.toml'),
        plan: 'plan.md',
        diff: 'change.diff',
        dependencies: ['pnpm-lock.yaml'],
        files: ['package.json'],
      }, {
        repoRoot: root,
        paths: { grokHome: join(root, 'grok'), tempParent: join(root, 'runs') },
        runDiagnostics: async () => ({ safe: true, version: 'grok 0.2.106', models: ['grok-4.5'] }),
        gitState: async () => ({ head: '0123456789abcdef', dirtyDigest: 'selected-files-digest' }),
        runner: async (options: any) => {
          runnerOptions = options
          return ({
            exitCode: 0,
            status: 'valid',
            evidence: {
              normalized: { searches: [
                { tool: 'web_search', status: 'completed' },
                { tool: 'x_search', status: 'completed' },
              ] },
              registry: { sources: [{ id: 'source-1', canonical_url: 'https://docs.x.ai/build/cli/reference' }] },
            },
            raw: { notifications: [] },
          })
        },
      })
      expect(result).toMatchObject({ exitCode: 0, status: 'valid', webSearches: 1, xSearches: 1 })
      expect(result.bindings.map((binding: any) => binding.kind)).toEqual(['plan', 'diff', 'dependency'])
      expect(await fs.pathExists(join(root, result.manifestPath))).toBe(true)
      expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(runnerOptions.model).toBe('grok-4.5')
      expect(await fs.readJson(join(root, result.manifestPath))).toMatchObject({ model: 'grok-4.5' })
    }
    finally {
      await fs.remove(root)
    }
  })

  it('requires a non-empty verify diff unless empty-diff semantics are explicit', async () => {
    const root = join(tmpdir(), `ccg-grok-required-diff-${Date.now()}`)
    await fs.ensureDir(root)
    await Promise.all([
      fs.writeFile(join(root, 'config.toml'), '[intelligence]\nenabled = true\nauth_mode = "browser_oauth"\n'),
      fs.writeFile(join(root, 'package.json'), '{}\n'),
      fs.writeFile(join(root, 'empty.diff'), ''),
    ])
    try {
      await expect(runManualCommand('verify', { task: 'Verify current API.', config: join(root, 'config.toml'), files: ['package.json'] }, { repoRoot: root }))
        .rejects
        .toThrow(/--diff/i)
      await expect(runManualCommand('verify', { task: 'Verify current API.', config: join(root, 'config.toml'), diff: 'empty.diff', files: ['package.json'] }, { repoRoot: root }))
        .rejects
        .toThrow(/empty diff/i)
    }
    finally {
      await fs.remove(root)
    }
  })

  it('hashes repository-wide tracked changes instead of only selected snapshot files', async () => {
    const root = join(tmpdir(), `ccg-grok-git-state-${Date.now()}`)
    await fs.ensureDir(join(root, 'src'))
    await fs.writeFile(join(root, 'package.json'), '{}\n')
    await fs.writeFile(join(root, 'src', 'feature.ts'), 'export const value = 1\n')
    execFileSync('git', ['init'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'CCG Test'], { cwd: root })
    execFileSync('git', ['add', 'package.json', 'src/feature.ts'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })
    try {
      const before = await defaultGitState(root, ['package.json'])
      await fs.writeFile(join(root, 'src', 'feature.ts'), 'export const value = 2\n')
      const after = await defaultGitState(root, ['package.json'])
      expect(after.head).toBe(before.head)
      expect(after.dirtyDigest).not.toBe(before.dirtyDigest)

      await fs.writeFile(join(root, 'src', 'untracked.ts'), 'export const draft = 1\n')
      const untrackedBefore = await defaultGitState(root, ['package.json'])
      await fs.writeFile(join(root, 'src', 'untracked.ts'), 'export const draft = 2\n')
      const untrackedAfter = await defaultGitState(root, ['package.json'])
      expect(untrackedAfter.dirtyDigest).not.toBe(untrackedBefore.dirtyDigest)
    }
    finally {
      await fs.remove(root)
    }
  }, 15_000)

  it('uses and fingerprints the configured deep research model', async () => {
    const root = join(tmpdir(), `ccg-grok-deep-model-${Date.now()}`)
    await fs.ensureDir(root)
    await Promise.all([
      fs.writeFile(join(root, 'config.toml'), '[intelligence]\nenabled = true\nauth_mode = "browser_oauth"\ndeep_research_enabled = true\ndefault_model = "grok-4.5"\ndeep_research_model = "grok-4.5-deep"\nartifact_root = ".codex/ccg/intelligence"\n'),
      fs.writeFile(join(root, 'package.json'), '{}\n'),
    ])
    let seen: any
    try {
      const result = await runManualCommand('intel', {
        task: 'Research the latest contract.',
        config: join(root, 'config.toml'),
        depth: 'deep',
        files: ['package.json'],
        officialDomains: ['vendor.example'],
      }, {
        repoRoot: root,
        paths: { grokHome: join(root, 'grok'), tempParent: join(root, 'runs') },
        runDiagnostics: async () => ({ safe: true, version: 'grok 0.2.106', models: ['grok-4.5', 'grok-4.5-deep'] }),
        gitState: async () => ({ head: '0123456789abcdef', dirtyDigest: 'repo-digest' }),
        runner: async (options: any) => {
          seen = options
          return {
            exitCode: 0,
            status: 'valid',
            evidence: { normalized: { searches: [{ tool: 'web_search', status: 'completed' }] }, registry: { sources: [] }, claims: [{ id: 'u', claim: 'Unresolved', status: 'unresolved', source_ids: [] }] },
            raw: { notifications: [] },
          }
        },
      })
      expect(result).toMatchObject({ exitCode: 0, model: 'grok-4.5-deep' })
      expect(seen.model).toBe('grok-4.5-deep')
      expect(seen.officialDomains).toEqual(['vendor.example'])
      expect(await fs.readJson(join(root, result.manifestPath))).toMatchObject({ model: 'grok-4.5-deep' })
    }
    finally {
      await fs.remove(root)
    }
  })

  it('reuses identical manual evidence while invalidating changed and force-refreshed requests', async () => {
    const root = join(tmpdir(), `ccg-grok-manual-cache-${Date.now()}`)
    const alias = `${root}-alias`
    await fs.ensureDir(root)
    await Promise.all([
      fs.writeFile(join(root, 'config.toml'), '[intelligence]\nenabled = true\nauth_mode = "browser_oauth"\ndefault_model = "grok-4.5"\nartifact_root = ".codex/ccg/intelligence"\n'),
      fs.writeFile(join(root, 'package.json'), '{}\n'),
      fs.writeFile(join(root, 'change.diff'), '+current contract\n'),
    ])
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const runner = vi.fn(async () => {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      return {
        exitCode: 0,
        status: 'valid',
        evidence: {
          normalized: { searches: [{ tool: 'web_search', status: 'completed' }] },
          registry: { sources: [{ id: 'source-1', canonical_url: 'https://docs.x.ai/build/cli/reference' }] },
          claims: [{ id: 'unresolved', claim: 'No applicable fact in fixture.', status: 'unresolved', severity: 'info', source_ids: [] }],
        },
        raw: { notifications: [] },
      }
    })
    const runtime = {
      repoRoot: alias,
      paths: { grokHome: join(root, 'grok'), neutralHome: join(root, 'neutral'), tempParent: join(root, 'runs') },
      runner,
      runDiagnostics: async () => ({ safe: true, version: 'grok 0.2.106', models: ['grok-4.5'] }),
      gitState: async () => ({ head: '0123456789abcdef', dirtyDigest: 'selected-files-digest' }),
    }
    const options = {
      task: 'Verify current API support.',
      config: join(alias, 'config.toml'),
      diff: 'change.diff',
      files: ['package.json'],
    }
    try {
      const first = await runManualCommand('verify', options, runtime)
      const second = await runManualCommand('verify', options, runtime)
      expect(runner).toHaveBeenCalledTimes(1)
      expect(first.cache).toMatchObject({ hit: false, reason: 'missing' })
      expect(second.cache).toMatchObject({ hit: true, reason: 'valid' })
      expect(second.manifestPath).toBe(first.manifestPath)
      expect(second.manifestSha256).toBe(first.manifestSha256)

      await fs.appendFile(join(root, first.manifestPath, '..', 'raw-stream.jsonl'), '{"tampered":true}\n')
      const repaired = await runManualCommand('verify', options, runtime)
      expect(runner).toHaveBeenCalledTimes(2)
      expect(repaired.cache).toMatchObject({ hit: false, reason: 'artifact_mismatch' })
      expect(repaired.manifestPath).not.toBe(first.manifestPath)

      await fs.writeFile(join(root, 'change.diff'), '+changed contract\n')
      const changed = await runManualCommand('verify', options, runtime)
      expect(runner).toHaveBeenCalledTimes(3)
      expect(changed.cache).toMatchObject({ hit: false })
      expect(changed.manifestPath).not.toBe(first.manifestPath)

      const refreshed = await runManualCommand('verify', { ...options, forceRefresh: true }, runtime)
      expect(runner).toHaveBeenCalledTimes(4)
      expect(refreshed.cache).toMatchObject({ hit: false, reason: 'force_refresh' })
      expect(refreshed.manifestPath).not.toBe(changed.manifestPath)
    }
    finally {
      await fs.remove(alias)
      await fs.remove(root)
    }
  })

  it('runs doctor diagnostics in a disposable credential-home copy', async () => {
    const root = join(tmpdir(), `ccg-grok-doctor-isolation-${Date.now()}`)
    const paths = {
      root,
      grokHome: join(root, 'grok-home'),
      neutralHome: join(root, 'neutral-home'),
      tempParent: join(root, 'runs'),
    }
    await ensureDedicatedGrokHome({ paths, platform: process.platform })
    await fs.ensureDir(join(paths.grokHome, 'logs'))
    const realLog = join(paths.grokHome, 'logs', 'unified.jsonl')
    await fs.writeFile(realLog, 'baseline\n')
    const runProcess = vi.fn(async (_command: string, args: string[], options: any) => {
      const isolatedLog = join(options.env.GROK_HOME, 'logs', 'unified.jsonl')
      await fs.ensureDir(join(options.env.GROK_HOME, 'logs'))
      await fs.appendFile(isolatedLog, '{"key_prefix":"must-not-persist"}\n')
      if (args.includes('--help'))
        return { stdout: 'agent models inspect', stderr: '', exitCode: 0 }
      if (args.includes('inspect'))
        return { stdout: '{"externalCompat":{"remoteSettingsLoaded":false,"cells":[]}}', stderr: '', exitCode: 0 }
      return { stdout: args.includes('version') ? 'grok 0.2.106' : args.includes('models') ? 'grok-4.5' : 'none configured', stderr: '', exitCode: 0 }
    })
    try {
      const isolate = (grokManage as any).runIsolatedGrokDiagnostics
      expect(isolate).toBeTypeOf('function')
      const result = await isolate({
        paths,
        authentication: { authMode: 'browser_oauth' },
        command: 'grok',
        sourceEnv: { PATH: process.env.PATH },
        runProcess,
      })
      expect(result.diagnostics).toMatchObject({ safe: true, version: 'grok 0.2.106' })
      expect(runProcess).toHaveBeenCalledTimes(6)
      expect(await fs.readFile(realLog, 'utf8')).toBe('baseline\n')
      expect(await fs.readdir(paths.tempParent)).toEqual([])
    }
    finally {
      await fs.remove(root)
    }
  }, 90_000)

  it('routes local doctor help and inventory through isolated diagnostics', async () => {
    const root = join(tmpdir(), `ccg-grok-local-doctor-${Date.now()}`)
    const paths = {
      root,
      grokHome: join(root, 'grok-home'),
      neutralHome: join(root, 'neutral-home'),
      tempParent: join(root, 'runs'),
    }
    try {
      await ensureDedicatedGrokHome({ paths, platform: process.platform })
      await fs.writeFile(join(paths.grokHome, 'auth.json'), '{"cached":"token"}\n')
      await fs.ensureDir(join(paths.grokHome, 'logs'))
      const historicalLog = join(paths.grokHome, 'logs', 'unified.jsonl')
      await fs.writeFile(historicalLog, '{"key_prefix":"historical-prefix"}\n')
      const isolatedDiagnostics = vi.fn(async () => ({
        help: { stdout: 'agent models inspect', stderr: '', exitCode: 0 },
        diagnostics: { safe: true, version: 'grok 0.2.106', models: ['grok-4.5'] },
      }))
      const localDoctor = (grokManage as any).localDoctor
      expect(localDoctor).toBeTypeOf('function')
      expect((grokManage as any).LOCAL_DOCTOR_ACP_TIMEOUT_MS).toBe(120_000)
      expect((grokManage as any).LIVE_DOCTOR_ACP_TIMEOUT_MS).toBe(300_000)
      const result = await localDoctor({
        paths,
        projectRoot: root,
        command: process.execPath,
        prefixArgs: [join(ROOT, 'templates', 'engine', 'tools', 'grok-intelligence', 'fake-wrapper.mjs')],
        sourceEnv: { PATH: process.env.PATH },
        runIsolatedDiagnostics: isolatedDiagnostics,
      })
      expect(isolatedDiagnostics).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ ok: true, paidModelPromptSent: false, version: 'grok 0.2.106' })
      expect(await fs.pathExists(historicalLog)).toBe(false)
    }
    finally {
      await fs.remove(root)
    }
  }, 90_000)
})
