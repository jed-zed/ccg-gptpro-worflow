import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs-extra'
// @ts-expect-error Runtime template modules intentionally ship as plain ESM.
import * as routeRuntime from '../../../templates/engine/tools/grok-intelligence/route.mjs'

const root = join(tmpdir(), `ccg-grok-route-${Date.now()}`)

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    auto_route: true,
    auth_mode: 'browser_oauth',
    require_web_search: true,
    x_search_policy: 'preferred',
    ...overrides,
  }
}

let evidenceCounter = 0

function statePath(id: string) {
  return join(root, '.codex', 'ccg', id, 'status.json')
}

function validRunnerResult(
  mode = 'contract',
  createdAt = new Date().toISOString(),
  model = 'grok-4.5',
  artifactRoot = '.codex/ccg/intelligence',
) {
  const evidenceId = `route-evidence-${++evidenceCounter}`
  const bundleDir = join(root, ...artifactRoot.split('/'), evidenceId)
  fs.ensureDirSync(bundleDir)
  const artifact = `${JSON.stringify({
    schemaVersion: 2,
    decision: { requirement: 'required', status: 'valid', mode: mode === 'verify' ? 'contract' : mode, reason: 'Verified fixture.', created_at: createdAt },
    evidence: {
      model: { requested: model, actual: model, provenance: 'grok agent --model' },
      claims: [{ id: 'claim-unresolved', claim: 'No applicable fact in fixture.', status: 'unresolved', source_ids: [] }],
    },
  }, null, 2)}\n`
  const raw = ''
  const report = '# Fixture\n'
  fs.writeFileSync(join(bundleDir, 'evidence.json'), artifact)
  fs.writeFileSync(join(bundleDir, 'raw-stream.jsonl'), raw)
  fs.writeFileSync(join(bundleDir, 'report.md'), report)
  const files = {
    'evidence.json': { sha256: hash(artifact), bytes: Buffer.byteLength(artifact) },
    'raw-stream.jsonl': { sha256: hash(raw), bytes: Buffer.byteLength(raw) },
    'report.md': { sha256: hash(report), bytes: Buffer.byteLength(report) },
  }
  const manifest = `${JSON.stringify({ schemaVersion: 1, evidenceId, createdAt, localOnly: true, exported: false, retentionDays: 7, model, files }, null, 2)}\n`
  fs.writeFileSync(join(bundleDir, 'manifest.json'), manifest)
  return {
    exitCode: 0,
    status: 'valid',
    model,
    evidencePath: `${artifactRoot}/${evidenceId}/evidence.json`,
    evidenceSha256: hash(artifact),
    manifestPath: `${artifactRoot}/${evidenceId}/manifest.json`,
    manifestSha256: hash(manifest),
  }
}

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

describe('Grok automatic intelligence routing', () => {
  beforeEach(async () => {
    await fs.emptyDir(root)
    evidenceCounter = 0
    await fs.writeJson(join(root, 'package.json'), { name: 'fixture' })
    await fs.writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await fs.writeFile(join(root, 'plan.md'), '# Plan\n')
    await fs.writeFile(join(root, 'change.diff'), '+ first external change\n')
  })

  afterAll(async () => {
    await fs.remove(root)
  })

  it('routes a dependency or API contract intake before the workflow and persists call order', async () => {
    const stateFile = join(root, '.ccg', 'tasks', 'route-contract', 'intelligence-route.json')
    const events: string[] = []
    let invocation: any
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'go',
      phase: 'intake',
      task: 'Upgrade the Acme SDK and verify its current API contract.',
      dependencies: ['pnpm-lock.yaml'],
      stateFile,
    }, {
      onEvent: (event: string) => events.push(event),
      invoke: async (request: any) => {
        events.push('invoke')
        invocation = request
        expect(fs.readJsonSync(stateFile)).toMatchObject({ execution: { status: 'pending' } })
        return validRunnerResult()
      },
    })

    expect(result).toMatchObject({
      exitCode: 0,
      invoked: true,
      decision: {
        requirement: 'required',
        mode: 'contract',
        trigger: 'dependency_api_contract',
        status: 'valid',
        effective_x_policy: 'preferred',
      },
    })
    expect(invocation).toMatchObject({ action: 'intel', options: { mode: 'contract' } })
    expect(invocation.argv).toEqual([
      'intel',
      '--task',
      'Upgrade the Acme SDK and verify its current API contract.',
      '--mode',
      'contract',
      '--dependency',
      'pnpm-lock.yaml',
    ])
    expect(events).toEqual(['decision', 'state:pending', 'invoke', 'state:complete'])
    expect(fs.readJsonSync(stateFile)).toMatchObject({
      execution: { status: 'valid', exit_code: 0 },
      bindings: { dependencies: [{ path: 'pnpm-lock.yaml', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] },
    })
  })

  it('routes a current incident with required Web evidence and policy-derived X evidence', async () => {
    let invocation: any
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'debug',
      phase: 'diagnosis',
      task: 'Diagnose the current Acme Cloud outage and recent regional errors.',
      stateFile: statePath('incident-state'),
    }, {
      invoke: async (request: any) => {
        invocation = request
        return validRunnerResult()
      },
    })

    expect(result.decision).toMatchObject({
      requirement: 'required',
      mode: 'incident',
      trigger: 'current_incident',
      require_web_search: true,
      configured_x_policy: 'preferred',
      effective_x_policy: 'required',
    })
    expect(invocation.argv).toEqual([
      'intel',
      '--task',
      'Diagnose the current Acme Cloud outage and recent regional errors.',
      '--mode',
      'incident',
    ])
  })

  it.each([
    ['missing config', undefined],
    ['disabled config', enabledConfig({ enabled: false })],
    ['disabled auto route', enabledConfig({ auto_route: false })],
  ])('makes zero runner calls for %s and records an auditable reason', async (_label, config) => {
    let calls = 0
    const stateFile = statePath(String(_label).replace(/\s/g, '-'))
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config,
      workflow: 'go',
      phase: 'intake',
      task: 'Upgrade the current SDK API.',
      stateFile,
    }, {
      invoke: async () => {
        calls++
        return validRunnerResult()
      },
    })

    expect(calls).toBe(0)
    expect(result).toMatchObject({ exitCode: 0, invoked: false, decision: { requirement: 'disabled', status: 'skipped' } })
    expect(result.decision.reason).toMatch(/disabled|explicit opt-in|configuration/i)
    expect(fs.readJsonSync(stateFile).decision.reason).toBe(result.decision.reason)
  })

  it('records a skip reason for task classes outside the initial automatic gates', async () => {
    let calls = 0
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'go',
      phase: 'intake',
      task: 'Rename a local helper and reformat its comments.',
      stateFile: statePath('local-skip'),
    }, {
      invoke: async () => {
        calls++
        return validRunnerResult()
      },
    })

    expect(calls).toBe(0)
    expect(result.decision).toMatchObject({ requirement: 'disabled', status: 'skipped', trigger: 'no_initial_trigger' })
    expect(result.decision.reason).toMatch(/no initial automatic external-intelligence trigger/i)
  })

  it('supports an explicit Codex semantic decision without requiring search words in the task', async () => {
    let invocation: any
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'plan',
      phase: 'intake',
      task: 'Assess whether this architecture is defensible.',
      semanticMode: 'contract',
      semanticReason: 'The design materially depends on a current third-party service capability.',
      stateFile: statePath('semantic-contract'),
    }, {
      invoke: async (request: any) => {
        invocation = request
        return validRunnerResult()
      },
    })

    expect(result.decision).toMatchObject({ mode: 'contract', trigger: 'codex_semantic_judgment', requirement: 'required' })
    expect(result.decision.reason).toContain('current third-party service capability')
    expect(invocation.action).toBe('intel')
  })

  it('reuses unchanged final verification and invalidates it on diff or dependency digest changes', async () => {
    const stateFile = statePath('verify-state')
    let calls = 0
    const invoke = async (request: any) => {
      calls++
      expect(request.action).toBe('verify')
      expect(request.argv).toContain('--diff')
      return validRunnerResult()
    }
    const input = {
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'review',
      phase: 'final-verify',
      task: 'Verify the applied external SDK change.',
      trigger: 'final_diff_verify',
      plan: 'plan.md',
      diff: 'change.diff',
      dependencies: ['pnpm-lock.yaml'],
      stateFile,
    }

    const first = await (routeRuntime as any).runWorkflowRoute(input, { invoke })
    const unchanged = await (routeRuntime as any).runWorkflowRoute(input, { invoke })
    expect(first.decision).toMatchObject({ mode: 'verify', requirement: 'required', trigger: 'final_diff_verify' })
    expect(unchanged).toMatchObject({ exitCode: 0, invoked: false, reused: true })
    expect(calls).toBe(1)

    await fs.writeFile(join(root, 'change.diff'), '+ changed external behavior\n')
    const diffChanged = await (routeRuntime as any).runWorkflowRoute(input, { invoke })
    expect(diffChanged.invoked).toBe(true)
    expect(calls).toBe(2)

    await fs.writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nnew-sdk: 2\n')
    const dependencyChanged = await (routeRuntime as any).runWorkflowRoute(input, { invoke })
    expect(dependencyChanged.invoked).toBe(true)
    expect(calls).toBe(3)
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state.bindings.diff.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(state.bindings.dependencies[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('invalidates automatic reuse on official policy, model, artifact root, or force-refresh changes', async () => {
    const stateFile = statePath('execution-profile-reuse')
    let calls = 0
    const input = {
      repoRoot: root,
      config: enabledConfig({ default_model: 'grok-4.5' }),
      workflow: 'go',
      phase: 'intake',
      task: 'Upgrade the current external SDK API.',
      stateFile,
    }
    const invoke = async (request: any) => {
      calls++
      const model = String(request.options.config.default_model || 'grok-4.5')
      const artifactRoot = String(request.options.config.artifact_root || '.codex/ccg/intelligence')
      return validRunnerResult('contract', new Date().toISOString(), model, artifactRoot)
    }

    await (routeRuntime as any).runWorkflowRoute(input, { invoke })
    expect(await (routeRuntime as any).runWorkflowRoute(input, { invoke })).toMatchObject({ reused: true })
    expect(calls).toBe(1)

    await (routeRuntime as any).runWorkflowRoute({ ...input, officialDomains: ['vendor.example'] }, { invoke })
    await (routeRuntime as any).runWorkflowRoute({
      ...input,
      officialDomains: ['vendor.example'],
      config: enabledConfig({ default_model: 'grok-4.5-fast' }),
    }, { invoke })
    await (routeRuntime as any).runWorkflowRoute({
      ...input,
      officialDomains: ['vendor.example'],
      config: enabledConfig({ default_model: 'grok-4.5-fast', artifact_root: '.codex/ccg/alternate-intelligence' }),
    }, { invoke })
    await (routeRuntime as any).runWorkflowRoute({ ...input, forceRefresh: true }, { invoke })
    expect(calls).toBe(5)
  })

  it('propagates required evidence exit 2 and records the blocking result', async () => {
    const stateFile = statePath('blocked-state')
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'go',
      phase: 'intake',
      task: 'Upgrade the current dependency API.',
      stateFile,
    }, {
      invoke: async () => ({ exitCode: 2, status: 'required_evidence_unavailable', reason: 'No source-backed Web result.' }),
    })

    expect(result).toMatchObject({ exitCode: 2, invoked: true })
    expect(fs.readJsonSync(stateFile)).toMatchObject({
      execution: { exit_code: 2, status: 'required_evidence_unavailable' },
      decision: { status: 'blocked' },
    })
  })

  it('fails closed when a successful runner result has no complete bundle', async () => {
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'go',
      phase: 'intake',
      task: 'Upgrade the current dependency API.',
      stateFile: statePath('missing-bundle'),
    }, { invoke: async () => ({ exitCode: 0, status: 'valid' }) })
    expect(result).toMatchObject({ exitCode: 3, decision: { status: 'blocked' }, execution: { status: 'unsafe_context' } })
  })

  it('revalidates hashes and freshness before reuse and reruns invalid evidence', async () => {
    const stateFile = statePath('reuse-validation')
    let now = new Date('2026-07-22T00:00:00.000Z')
    let calls = 0
    const input = {
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'go',
      phase: 'intake',
      task: 'Upgrade the current dependency API.',
      stateFile,
    }
    const runtime = {
      clock: () => now,
      invoke: async () => {
        calls++
        return validRunnerResult('contract', now.toISOString())
      },
    }
    const first = await (routeRuntime as any).runWorkflowRoute(input, runtime)
    await fs.appendFile(join(root, first.execution.evidence_path), '\ntampered')
    const afterTamper = await (routeRuntime as any).runWorkflowRoute(input, runtime)
    expect(afterTamper).toMatchObject({ invoked: true, reused: false, exitCode: 0 })
    expect(calls).toBe(2)

    now = new Date('2026-07-26T00:00:00.000Z')
    const afterExpiry = await (routeRuntime as any).runWorkflowRoute(input, runtime)
    expect(afterExpiry).toMatchObject({ invoked: true, reused: false, exitCode: 0 })
    expect(calls).toBe(3)
  })

  it('publishes a validated successful bundle into canonical task evidence and pointer state', async () => {
    const taskDir = join(root, '.ccg', 'tasks', 'canonical-route')
    const stateFile = join(taskDir, 'intelligence-route.json')
    await fs.ensureDir(taskDir)
    await fs.writeJson(join(taskDir, 'task.json'), { id: 'canonical-route', status: 'in_progress' })
    const evidenceId = 'route-contract-1'
    const bundleDir = join(root, '.codex', 'ccg', 'intelligence', evidenceId)
    await fs.ensureDir(bundleDir)
    const createdAt = new Date().toISOString()
    const model = 'grok-4.5'
    const artifact = `${JSON.stringify({
      schemaVersion: 2,
      decision: {
        requirement: 'required',
        status: 'valid',
        mode: 'contract',
        reason: 'Current contract verified.',
        created_at: createdAt,
      },
      evidence: {
        model: { requested: model, actual: model, provenance: 'grok agent --model' },
        claims: [{ id: 'unresolved', claim: 'No applicable fixture claim.', status: 'unresolved', source_ids: [] }],
      },
    }, null, 2)}\n`
    const artifactSha256 = hash(artifact)
    const raw = ''
    const report = '# Canonical fixture\n'
    await fs.writeFile(join(bundleDir, 'raw-stream.jsonl'), raw)
    await fs.writeFile(join(bundleDir, 'report.md'), report)
    const manifest = `${JSON.stringify({
      schemaVersion: 1,
      evidenceId,
      createdAt,
      localOnly: true,
      exported: false,
      model,
      files: {
        'evidence.json': { sha256: artifactSha256, bytes: Buffer.byteLength(artifact) },
        'raw-stream.jsonl': { sha256: hash(raw), bytes: Buffer.byteLength(raw) },
        'report.md': { sha256: hash(report), bytes: Buffer.byteLength(report) },
      },
    }, null, 2)}\n`
    const manifestSha256 = hash(manifest)
    await fs.writeFile(join(bundleDir, 'evidence.json'), artifact)
    await fs.writeFile(join(bundleDir, 'manifest.json'), manifest)

    await (routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'gptpro-plan',
      phase: 'intake',
      task: 'Upgrade the Acme SDK API contract.',
      taskDir,
      stateFile,
    }, {
      invoke: async () => ({
        exitCode: 0,
        status: 'valid',
        evidencePath: `.codex/ccg/intelligence/${evidenceId}/evidence.json`,
        evidenceSha256: artifactSha256,
        manifestPath: `.codex/ccg/intelligence/${evidenceId}/manifest.json`,
        manifestSha256,
        model,
      }),
    })

    expect(fs.readJsonSync(join(taskDir, 'evidence.json')).items).toContainEqual(expect.objectContaining({
      id: `grok-external-intelligence-${evidenceId}`,
      provider: 'grok',
      role: 'external-intelligence',
      policy: 'required',
      artifactSha256,
      manifestSha256,
      localOnly: true,
      exported: false,
    }))
    expect(fs.readJsonSync(join(taskDir, 'task.json')).intelligence).toMatchObject({
      requirement: 'required',
      status: 'valid',
      evidence_id: evidenceId,
      manifest_sha256: manifestSha256,
      localOnly: true,
      exported: false,
    })
    expect(fs.readJsonSync(stateFile).canonical_evidence).toMatchObject({
      evidence_id: evidenceId,
      artifact_sha256: artifactSha256,
      manifest_sha256: manifestSha256,
    })
  })

  it('rejects plan and dependency paths that escape through a link or junction', async () => {
    const outside = join(tmpdir(), `ccg-grok-route-outside-${Date.now()}`)
    const linked = join(root, 'linked-outside')
    await fs.ensureDir(outside)
    await fs.writeFile(join(outside, 'plan.md'), '# Outside plan\n')
    try {
      await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    }
    catch (error: any) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code))
        return
      throw error
    }
    let calls = 0
    await expect((routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'gptpro-plan',
      phase: 'intake',
      task: 'Verify the current SDK API contract.',
      plan: 'linked-outside/plan.md',
      stateFile: statePath('linked-state'),
    }, {
      invoke: async () => {
        calls++
        return validRunnerResult()
      },
    })).rejects.toThrow(/link|junction|repository/i)
    expect(calls).toBe(0)
    await fs.remove(outside)
  })

  it('rejects arbitrary state files before invoking the runner', async () => {
    let calls = 0
    await expect((routeRuntime as any).runWorkflowRoute({
      repoRoot: root,
      config: enabledConfig(),
      workflow: 'go',
      phase: 'intake',
      task: 'Upgrade the current SDK API.',
      stateFile: join(root, 'package.json'),
    }, {
      invoke: async () => {
        calls++
        return validRunnerResult()
      },
    })).rejects.toThrow(/state file must match/i)
    expect(calls).toBe(0)
    expect(await fs.readJson(join(root, 'package.json'))).toEqual({ name: 'fixture' })
  })
})
