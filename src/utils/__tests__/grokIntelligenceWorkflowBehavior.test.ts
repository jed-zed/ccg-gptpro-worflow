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

  it('declares the initial executable workflow coverage and mirrors every listed surface', () => {
    const coveragePath = join(packageRoot, 'templates', 'engine', 'tools', 'grok-intelligence', 'workflow-coverage.json')
    expect(fs.pathExistsSync(coveragePath)).toBe(true)
    const coverage = fs.readJsonSync(coveragePath)
    expect(coverage).toMatchObject({ schemaVersion: 1, runtime: 'tools/grok-intelligence/route.mjs' })
    expect(coverage.workflows.map((entry: any) => entry.id)).toEqual([
      'go', 'gptpro-plan', 'gptpro-exc', 'gptpro-review',
    ])

    for (const entry of coverage.workflows) {
      expect(entry.families).toEqual(expect.arrayContaining(['initial-auto-route']))
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
