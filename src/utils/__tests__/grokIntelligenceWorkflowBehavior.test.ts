import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'fs-extra'
// @ts-expect-error Runtime template modules intentionally ship as plain ESM.
import * as routeRuntime from '../../../templates/engine/tools/grok-intelligence/route.mjs'
// @ts-expect-error Runtime template modules intentionally ship as plain ESM.
import { bindClaims, buildSourceRegistry } from '../../../templates/engine/tools/grok-intelligence/lib/source-registry.mjs'
// @ts-expect-error Runtime template modules intentionally ship as plain ESM.
import { resolveEffectiveXPolicy, validateEvidencePackage } from '../../../templates/engine/tools/grok-intelligence/lib/validator.mjs'

const packageRoot = resolve('.')
const tempRoot = join(tmpdir(), `ccg-grok-workflow-${Date.now()}`)
const routeCommand = 'node ~/.claude/.ccg/engine/tools/grok-intelligence/route.mjs'

describe('Grok workflow routing behavior', () => {
  afterAll(async () => {
    await fs.remove(tempRoot)
  })

  it('declares executable coverage for every automatic-routing family and mirrors every listed surface', () => {
    const coveragePath = join(packageRoot, 'templates', 'engine', 'tools', 'grok-intelligence', 'workflow-coverage.json')
    expect(fs.pathExistsSync(coveragePath)).toBe(true)
    const coverage = fs.readJsonSync(coveragePath)
    expect(coverage).toMatchObject({ schemaVersion: 1, runtime: 'tools/grok-intelligence/route.mjs' })
    const families = new Set(coverage.workflows.flatMap((entry: any) => entry.families))
    expect(families).toEqual(new Set([
      'go-plan',
      'execute-feat',
      'review-verify',
      'team',
      'spec',
      'gptpro',
      'quality-gates',
    ]))
    expect(coverage.defaultSkips).toEqual([
      'commit', 'rollback', 'clean-branches', 'worktree', 'context',
    ])
    for (const entry of coverage.defaultSkipSurfaces) {
      expect(coverage.defaultSkips).toContain(entry.id)
      for (const relativePath of entry.surfaces) {
        const content = readFileSync(join(packageRoot, ...relativePath.split('/')), 'utf8')
        expect(content, relativePath).not.toContain(routeCommand)
        expect(content, relativePath).toMatch(/does not invoke|不调用.*Grok/i)
      }
    }

    for (const entry of coverage.workflows) {
      expect(entry.surfaces.length).toBeGreaterThan(0)
      for (const relativePath of entry.surfaces) {
        const content = readFileSync(join(packageRoot, ...relativePath.split('/')), 'utf8')
        expect(content, relativePath).toContain(routeCommand)
        expect(content, relativePath).toContain(`--workflow ${entry.id}`)
        expect(content, relativePath).toContain('--state-file')
        expect(content, relativePath).toMatch(/exit (?:code )?`?2(?:`, `3`, or `4|\/3\/4)/i)
      }
    }
  })

  it('runs one shared Team decision and reuses it for identical teammate context', async () => {
    const repoRoot = join(tempRoot, 'team-family')
    await fs.ensureDir(repoRoot)
    await fs.writeJson(join(repoRoot, 'package.json'), { name: 'fixture' })
    const stateFile = join(repoRoot, '.ccg', 'tasks', 'team-task', 'intelligence-route.json')
    const invocations: any[] = []
    const events: string[] = []
    const input = {
      repoRoot,
      config: { enabled: true, auto_route: true, require_web_search: true, x_search_policy: 'preferred' },
      workflow: 'team',
      phase: 'team-intake',
      task: 'Upgrade the current SDK contract for all builders.',
      stateFile,
    }
    const runtime = {
      invoke: async (request: any) => {
        invocations.push(request)
        return { exitCode: 0, status: 'valid' }
      },
      onEvent: (event: string) => events.push(event),
    }

    const leader = await (routeRuntime as any).runWorkflowRoute(input, runtime)
    const teammate = await (routeRuntime as any).runWorkflowRoute(input, runtime)

    expect(leader).toMatchObject({ invoked: true, reused: false, workflow: 'team', phase: 'team-intake' })
    expect(teammate).toMatchObject({ invoked: false, reused: true })
    expect(invocations).toHaveLength(1)
    expect(events).toEqual(['decision', 'state:pending', 'state:complete', 'decision'])
    expect(await fs.readJson(stateFile)).toMatchObject({ decision: { status: 'valid' }, execution: { invoked: true } })
  })

  it.each([
    ['go-plan', 'plan', 'intake', undefined],
    ['execute-feat', 'feat', 'implementation', undefined],
    ['review-verify', 'review', 'final-verify', 'final_diff_verify'],
    ['gptpro', 'gptpro-plan', 'intake', undefined],
  ])('runs the %s family gate before its ordinary workflow', async (_family, workflow, phase, trigger) => {
    const repoRoot = join(tempRoot, `family-${workflow}`)
    await fs.ensureDir(repoRoot)
    const stateFile = join(repoRoot, 'route.json')
    const order: string[] = []
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot,
      config: { enabled: true, auto_route: true, require_web_search: true, x_search_policy: 'disabled' },
      workflow,
      phase,
      trigger,
      task: 'Use the latest SDK API contract in this workflow.',
      stateFile,
    }, {
      onEvent: (event: string) => order.push(event),
      invoke: async () => {
        order.push('runner')
        return { exitCode: 0, status: 'valid' }
      },
    })

    expect(result).toMatchObject({ invoked: true, workflow, phase, decision: { status: 'valid' } })
    expect(order).toEqual(['decision', 'state:pending', 'runner', 'state:complete'])
    expect(await fs.readJson(stateFile)).toMatchObject({ workflow, phase, execution: { invoked: true } })
  })

  it('invalidates Spec evidence when proposal, plan, diff, target, or phase bindings change', async () => {
    const repoRoot = join(tempRoot, 'spec-family')
    await fs.ensureDir(repoRoot)
    const proposal = join(repoRoot, 'proposal.md')
    const plan = join(repoRoot, 'plan.md')
    const diff = join(repoRoot, 'change.diff')
    const target = join(repoRoot, 'target.txt')
    await Promise.all([
      fs.writeFile(proposal, 'proposal-v1'),
      fs.writeFile(plan, 'plan-v1'),
      fs.writeFile(diff, 'diff-v1'),
      fs.writeFile(target, 'target-v1'),
    ])
    const stateFile = join(repoRoot, 'spec-route.json')
    const invocations: any[] = []
    const runtime = { invoke: async (request: any) => {
      invocations.push(request)
      return { exitCode: 0, status: 'valid' }
    } }
    const base = {
      repoRoot,
      config: { enabled: true, auto_route: true, require_web_search: true, x_search_policy: 'disabled' },
      workflow: 'spec-plan',
      phase: 'spec-plan',
      task: 'Plan an SDK API compatibility upgrade.',
      plan,
      target,
      dependencies: [proposal],
      stateFile,
    }

    expect(await (routeRuntime as any).runWorkflowRoute(base, runtime)).toMatchObject({ invoked: true })
    expect(await (routeRuntime as any).runWorkflowRoute(base, runtime)).toMatchObject({ reused: true })
    await fs.writeFile(proposal, 'proposal-v2')
    expect(await (routeRuntime as any).runWorkflowRoute(base, runtime)).toMatchObject({ invoked: true })
    await fs.writeFile(plan, 'plan-v2')
    expect(await (routeRuntime as any).runWorkflowRoute(base, runtime)).toMatchObject({ invoked: true })
    await fs.writeFile(target, 'target-v2')
    expect(await (routeRuntime as any).runWorkflowRoute(base, runtime)).toMatchObject({ invoked: true })
    expect(await (routeRuntime as any).runWorkflowRoute({
      ...base,
      phase: 'final-verify',
      trigger: 'final_diff_verify',
      diff,
    }, runtime)).toMatchObject({ invoked: true, phase: 'final-verify' })
    await fs.writeFile(diff, 'diff-v2')
    expect(await (routeRuntime as any).runWorkflowRoute({
      ...base,
      phase: 'final-verify',
      trigger: 'final_diff_verify',
      diff,
    }, runtime)).toMatchObject({ invoked: true })
    expect(invocations).toHaveLength(6)
  })

  it('keeps local quality gates offline and invokes external-contract quality checks in order', async () => {
    const repoRoot = join(tempRoot, 'quality-family')
    await fs.ensureDir(repoRoot)
    const target = join(repoRoot, 'changed.ts')
    await fs.writeFile(target, 'export const value = 1\n')
    const invocations: any[] = []
    const events: string[] = []
    const runtime = {
      invoke: async (request: any) => {
        invocations.push(request)
        return { exitCode: 0, status: 'valid' }
      },
      onEvent: (event: string) => events.push(event),
    }
    const common = {
      repoRoot,
      config: { enabled: true, auto_route: true, require_web_search: true, x_search_policy: 'disabled' },
      workflow: 'verify-quality',
      phase: 'quality-verify',
      target,
      stateFile: join(repoRoot, 'quality-route.json'),
    }

    const local = await (routeRuntime as any).runWorkflowRoute({ ...common, task: 'Check local formatting.' }, runtime)
    expect(local).toMatchObject({ invoked: false, decision: { trigger: 'no_initial_trigger' } })
    const external = await (routeRuntime as any).runWorkflowRoute({
      ...common,
      task: 'Verify compatibility with the latest external SDK API contract.',
    }, runtime)
    expect(external).toMatchObject({ invoked: true, decision: { trigger: 'dependency_api_contract' } })
    expect(invocations).toHaveLength(1)
    expect(events).toEqual(['decision', 'state:complete', 'decision', 'state:pending', 'state:complete'])
  })

  it('places the executable Grok gate before ordinary work on representative entrypoints', () => {
    const surfaces = [
      ['templates/commands/go.md', '## Phase 0: 逃生舱检测'],
      ['templates/commands/gptpro-plan.md', 'Then run ordinary `/ccg:plan`'],
      ['templates/commands/gptpro-exc.md', 'Then run ordinary'],
      ['templates/commands/gptpro-review.md', 'Then run ordinary `/ccg:review`'],
      ['plugins/ccg/skills/ccg-go/SKILL.md', 'Inspect the user'],
      ['plugins/ccg/skills/ccg-gptpro-plan/SKILL.md', 'Run ordinary `/ccg:plan`'],
      ['plugins/ccg/skills/ccg-gptpro-exc/SKILL.md', 'Preserve the current CCG orchestrator'],
      ['plugins/ccg/skills/ccg-gptpro-review/SKILL.md', 'Run ordinary `/ccg:review`'],
    ] as const
    for (const [relativePath, ordinaryMarker] of surfaces) {
      const content = readFileSync(join(packageRoot, ...relativePath.split('/')), 'utf8')
      const routeIndex = content.indexOf(routeCommand)
      expect(routeIndex, relativePath).toBeGreaterThanOrEqual(0)
      expect(routeIndex, relativePath).toBeLessThan(content.indexOf(ordinaryMarker))
    }
  })

  it('derives X policy by mode and lets landscape succeed without X evidence', () => {
    expect(resolveEffectiveXPolicy('preferred', 'incident')).toBe('required')
    expect(resolveEffectiveXPolicy('preferred', 'landscape')).toBe('preferred')
    expect(resolveEffectiveXPolicy('disabled', 'incident')).toBe('disabled')

    const registry = buildSourceRegistry({
      searches: [{
        tool: 'web_search', observed_tool: 'web_search', status: 'completed', query: 'current market',
        sources: [{ url: 'https://docs.x.ai/overview' }], toolCallId: 'web-1', backend: true,
      }],
    }, {
      retrievedAt: '2026-07-21T00:00:00.000Z',
      officialDomains: ['docs.x.ai'],
      officialXAccounts: ['xai'],
      domainTiers: {},
    })
    expect(validateEvidencePackage({
      normalized: { searches: [{ tool: 'web_search', status: 'completed', sources: [{}] }] },
      registry,
      claims: [],
      requireWebSearch: true,
      xSearchPolicy: 'preferred',
      mode: 'landscape',
    })).toMatchObject({ valid: true, warnings: [expect.stringMatching(/preferred X/i)] })
  })

  it('keeps X-only material advisory and never elevates it into a blocker', () => {
    const registry = buildSourceRegistry({
      searches: [{
        tool: 'x_search', observed_tool: 'web_search', status: 'completed', query: 'site:x.com from:xai',
        sources: [{ url: 'https://x.com/xai/status/1' }], toolCallId: 'x-1', backend: true,
      }],
    }, {
      retrievedAt: '2026-07-21T00:00:00.000Z',
      officialDomains: ['docs.x.ai'],
      officialXAccounts: ['xai'],
      domainTiers: {},
    })
    const claims = bindClaims([{
      id: 'x-radar',
      claim: 'A maintainer post may indicate an early rollout.',
      status: 'early_warning',
      severity: 'warning',
      source_ids: [registry.sources[0].id],
    }], registry)
    expect(validateEvidencePackage({
      normalized: { searches: [{ tool: 'x_search', status: 'completed', sources: [{}] }] },
      registry,
      claims,
      requireWebSearch: false,
      xSearchPolicy: 'preferred',
      mode: 'landscape',
    })).toMatchObject({ valid: true, errors: [], evaluated_claims: [{ id: 'x-radar', blocker: null }] })
  })

  it('passes disabled X policy through one Web intelligence route without an X invocation', async () => {
    await fs.emptyDir(tempRoot)
    await fs.writeJson(join(tempRoot, 'package.json'), { name: 'fixture' })
    const invocations: any[] = []
    const result = await (routeRuntime as any).runWorkflowRoute({
      repoRoot: tempRoot,
      config: {
        enabled: true,
        auto_route: true,
        auth_mode: 'browser_oauth',
        require_web_search: true,
        x_search_policy: 'disabled',
      },
      workflow: 'debug',
      phase: 'diagnosis',
      task: 'Diagnose the current hosted API outage.',
      stateFile: join(tempRoot, 'state.json'),
    }, {
      invoke: async (request: any) => {
        invocations.push(request)
        return { exitCode: 0, status: 'valid' }
      },
    })

    expect(result.decision).toMatchObject({ effective_x_policy: 'disabled' })
    expect(invocations).toHaveLength(1)
    expect(invocations[0].options.config.x_search_policy).toBe('disabled')
    expect(invocations[0].argv.join(' ')).not.toMatch(/x-search|x\.com/i)
  })
})
