import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Runtime template modules intentionally ship as plain ESM.
import { parseAcpJsonl, normalizeAcpEvents } from '../../../templates/engine/tools/grok-intelligence/lib/events.mjs'
// @ts-expect-error Runtime template modules intentionally ship as plain ESM.
import { bindClaims, bindClaimsFromObservedUrls, buildSourceRegistry, canonicalizeSourceUrl, createSynthesisInput } from '../../../templates/engine/tools/grok-intelligence/lib/source-registry.mjs'
// @ts-expect-error Runtime template modules intentionally ship as plain ESM.
import { assertValidEvidencePackage, resolveEffectiveXPolicy, validateEvidencePackage } from '../../../templates/engine/tools/grok-intelligence/lib/validator.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureRoot = join(repoRoot, 'templates', 'engine', 'tools', 'grok-intelligence', 'fixtures')
const retrievedAt = '2026-07-21T12:00:00.000Z'

async function readFixture(name: string) {
  return readFile(join(fixtureRoot, name), 'utf8')
}

function registryOptions() {
  return {
    retrievedAt,
    officialDomains: ['docs.x.ai', 'x.ai'],
    officialXAccounts: ['xai', 'grok'],
    domainTiers: {
      'github.com': 'B',
      'ai-sdk.dev': 'B',
      'example-a.test': 'B',
      'example-b.test': 'B',
    },
  }
}

describe('Grok ACP event normalization', () => {
  it('recognizes the probed WebSearch lifecycle and final turn', async () => {
    const messages = parseAcpJsonl(await readFixture('acp-web-success.jsonl'))
    const normalized = normalizeAcpEvents(messages, { requireComplete: true })

    expect(normalized.searches).toHaveLength(1)
    expect(normalized.searches[0]).toMatchObject({
      tool: 'web_search',
      status: 'completed',
      query: 'xAI Grok CLI official reference documentation',
    })
    expect(normalized.searches[0].sources).toHaveLength(9)
    expect(normalized.finalText).toContain('docs.x.ai/build/cli/reference')
    expect(normalized.turnCompleted).toMatchObject({ stop_reason: 'end_turn' })
    expect(normalized.unknownEvents).toEqual([])
  })

  it('classifies X-domain WebSearch but rejects a prose-only X URL', async () => {
    const normalized = normalizeAcpEvents(
      parseAcpJsonl(await readFixture('acp-x-empty-sources.jsonl')),
      { requireComplete: true },
    )
    expect(normalized.searches[0]).toMatchObject({ tool: 'x_search', sources: [] })
    expect(normalized.finalText).toContain('https://x.com/xai/status/')

    const registry = buildSourceRegistry(normalized, registryOptions())
    expect(registry.sources).toEqual([])
    expect(() => bindClaims([{ id: 'claim-x', url: 'https://x.com/xai/status/2004641808615932272' }], registry))
      .toThrow(/unobserved source|URL/i)
  })

  it('rejects malformed, truncated, and uncorrelated required streams', async () => {
    expect(() => parseAcpJsonl('{not-json\n')).toThrow(/line 1|malformed/i)

    const webMessages = parseAcpJsonl(await readFixture('acp-web-success.jsonl'))
    expect(() => normalizeAcpEvents(webMessages.slice(0, -1), { requireComplete: true }))
      .toThrow(/turn_completed|truncated/i)

    const uncorrelated = [{
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'missing',
          status: 'completed',
          rawOutput: { action: { query: 'test', sources: [] } },
        },
      },
    }]
    expect(() => normalizeAcpEvents(uncorrelated, { requireComplete: false })).toThrow(/uncorrelated/i)
  })

  it('uses a correlated prompt response as completion when the optional xAI turn event is absent', async () => {
    const messages = parseAcpJsonl(await readFixture('acp-web-success.jsonl'))
      .filter((message: any) => message.params?.update?.sessionUpdate !== 'turn_completed')
    const normalized = normalizeAcpEvents(messages, { requireComplete: true, promptCompleted: true })
    expect(normalized.turnCompleted).toMatchObject({
      stop_reason: 'prompt_response',
      observed: false,
    })
    expect(normalized.searches).toHaveLength(1)
    expect(normalized.finalText).toContain('docs.x.ai/build/cli/reference')
  })

  it('preserves unknown events for diagnostics without treating them as evidence', () => {
    const normalized = normalizeAcpEvents([{ method: 'future/event', params: { value: 1 } }], {
      requireComplete: false,
    })
    expect(normalized.events).toEqual([])
    expect(normalized.unknownEvents).toEqual([{ method: 'future/event', params: { value: 1 } }])
  })

  it('correlates native XSearch as advisory-only evidence without inventing source URLs', () => {
    const normalized = normalizeAcpEvents([
      {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'x-native-1',
            kind: 'search',
            status: 'in_progress',
            rawInput: { variant: 'XSearch', backend: true },
          },
        },
      },
      {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'x-native-1',
            status: 'completed',
            rawOutput: {
              call_id: 'xs-call-1',
              input: 'from:xai Grok Build CLI',
              name: 'x_keyword_search',
              id: 'x-native-1',
            },
          },
        },
      },
    ], { requireComplete: false })

    expect(normalized.searches).toEqual([expect.objectContaining({
      kind: 'search_advisory',
      tool: 'x_search',
      observed_tool: 'x_search',
      toolCallId: 'x-native-1',
      query: 'from:xai Grok Build CLI',
      status: 'completed',
      sources: [],
    })])
    const registry = buildSourceRegistry(normalized, registryOptions())
    expect(registry.sources).toEqual([])
    expect(registry.searches).toEqual([expect.objectContaining({
      tool: 'x_search',
      observed_tool: 'x_search',
      source_ids: [],
    })])
  })

  it('distinguishes a failed WebSearch update from a successful result', () => {
    const normalized = normalizeAcpEvents([
      {
        method: 'session/update',
        params: { update: { sessionUpdate: 'tool_call', toolCallId: 'failed', kind: 'search', rawInput: { variant: 'WebSearch', backend: true } } },
      },
      {
        method: 'session/update',
        params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'failed', status: 'failed', rawOutput: { error: 'rate limited' } } },
      },
    ], { requireComplete: false })
    expect(normalized.searches[0]).toMatchObject({
      kind: 'search_error',
      tool: 'web_search',
      status: 'failed',
      sources: [],
      error: 'rate limited',
    })
  })
})

describe('runtime source registry', () => {
  it('creates deterministic IDs only from observed tool sources', async () => {
    const normalized = normalizeAcpEvents(
      parseAcpJsonl(await readFixture('acp-web-success.jsonl')),
      { requireComplete: true },
    )
    const registry = buildSourceRegistry(normalized, registryOptions())
    const reference = registry.sources.find((source: any) => source.canonical_url === 'https://docs.x.ai/build/cli/reference')

    expect(reference).toMatchObject({
      id: expect.stringMatching(/^src-[a-f0-9]{16}$/),
      tool: 'web_search',
      canonical_url: 'https://docs.x.ai/build/cli/reference',
      retrieved_at: retrievedAt,
      official: true,
      source_tier: 'A',
    })
    expect(buildSourceRegistry(normalized, registryOptions())).toEqual(registry)
  })

  it('canonicalizes equivalent URLs while preserving semantic query parameters', () => {
    expect(canonicalizeSourceUrl('HTTPS://Example.COM:443/path?b=2&utm_source=x&a=1#fragment'))
      .toBe('https://example.com/path?a=1&b=2')

    const registry = buildSourceRegistry({
      searches: [{
        tool: 'web_search',
        observed_tool: 'web_search',
        toolCallId: 'call-1',
        query: 'test',
        status: 'completed',
        sources: [
          { url: 'https://example.com/path?a=1&utm_campaign=one' },
          { url: 'https://EXAMPLE.com:443/path?a=1#two' },
        ],
      }],
    }, registryOptions())
    expect(registry.sources).toHaveLength(1)
    expect(registry.sources[0].canonical_url).toBe('https://example.com/path?a=1')
    expect(() => buildSourceRegistry({
      searches: [{
        tool: 'web_search',
        toolCallId: 'forged',
        query: 'forged',
        status: 'completed',
        sources: [{ url: 'https://invented.invalid' }],
      }],
    }, registryOptions())).toThrow(/built-in WebSearch/i)
  })

  it('builds a URL-free synthesis input and only accepts registry IDs back', async () => {
    const normalized = normalizeAcpEvents(
      parseAcpJsonl(await readFixture('acp-web-success.jsonl')),
      { requireComplete: true },
    )
    const registry = buildSourceRegistry(normalized, registryOptions())
    const synthesisInput = createSynthesisInput(normalized, registry)
    expect(JSON.stringify(synthesisInput)).not.toMatch(/https?:\/\//i)
    const queryWithUrl = createSynthesisInput(normalized, {
      ...registry,
      searches: registry.searches.map((search: any) => ({ ...search, query: 'check https://secret.invalid/path' })),
    })
    expect(JSON.stringify(queryWithUrl)).not.toContain('https://secret.invalid')

    const sourceId = registry.sources[0].id
    const claims = bindClaims([{
      id: 'claim-1',
      claim: 'The source was observed by the runtime.',
      status: 'verified',
      source_ids: [sourceId],
    }], registry)
    expect(claims[0].source_ids).toEqual([sourceId])

    expect(() => bindClaims([{
      id: 'claim-bad',
      claim: 'Invented source https://invented.invalid',
      status: 'verified',
      source_ids: [sourceId],
    }], registry)).toThrow(/URL/i)
    expect(() => bindClaims([{
      id: 'claim-bad',
      claim: 'Model elevates policy',
      status: 'verified',
      source_ids: [sourceId],
      source_tier: 'A',
    }], registry)).toThrow(/source policy|source_tier/i)
    expect(() => bindClaims([{
      id: 'claim-bad',
      claim: 'Model claims local applicability',
      status: 'verified',
      source_ids: [sourceId],
      observed_applicability: true,
    }], registry)).toThrow(/runtime source policy|observed_applicability/i)
    expect(() => bindClaims([{
      id: 'claim-bad',
      claim: 'Unknown registry ID',
      status: 'verified',
      source_ids: ['src-0000000000000000'],
    }], registry)).toThrow(/unobserved source/i)
  })

  it('supports deterministic fallback binding only for observed URLs', () => {
    const registry = buildSourceRegistry({
      searches: [{
        tool: 'web_search',
        observed_tool: 'web_search',
        toolCallId: 'call-1',
        query: 'contract',
        status: 'completed',
        sources: [{ url: 'https://docs.x.ai/build/cli/reference' }],
      }],
    }, registryOptions())
    expect(bindClaimsFromObservedUrls([{
      id: 'claim-1',
      claim: 'Observed fallback',
      status: 'verified',
      urls: ['https://docs.x.ai/build/cli/reference#fragment'],
    }], registry)[0].source_ids).toEqual([registry.sources[0].id])
    expect(() => bindClaimsFromObservedUrls([{
      id: 'claim-bad',
      claim: 'Invented fallback',
      status: 'verified',
      urls: ['https://invented.invalid'],
    }], registry)).toThrow(/unobserved source/i)
  })
})

describe('deterministic evidence policy', () => {
  function makePolicyRegistry(sources: Array<{ url: string, tool?: string }>) {
    return buildSourceRegistry({
      searches: sources.map((source, index) => ({
        tool: source.tool || 'web_search',
        observed_tool: 'web_search',
        toolCallId: `call-${index}`,
        query: source.tool === 'x_search' ? 'site:x.com incident' : 'contract',
        status: 'completed',
        sources: [{ url: source.url }],
      })),
    }, registryOptions())
  }

  it('allows blocker claims only with primary applicability or two independent reputable sources', () => {
    const primaryRegistry = makePolicyRegistry([{ url: 'https://docs.x.ai/build/cli/reference' }])
    const primaryClaim = bindClaims([{
      id: 'primary',
      claim: 'Authoritative and applicable.',
      status: 'verified',
      severity: 'blocker',
      source_ids: [primaryRegistry.sources[0].id],
    }], primaryRegistry, { observedApplicabilityByClaim: { primary: true } })
    expect(validateEvidencePackage({
      normalized: { searches: [{ tool: 'web_search', sources: [{}], status: 'completed' }] },
      registry: primaryRegistry,
      claims: primaryClaim,
      requireWebSearch: true,
      xSearchPolicy: 'disabled',
      mode: 'contract',
    })).toMatchObject({ valid: true })

    const reputableRegistry = makePolicyRegistry([
      { url: 'https://example-a.test/report' },
      { url: 'https://example-b.test/report' },
    ])
    const reputableClaim = bindClaims([{
      id: 'corroborated',
      claim: 'Independently corroborated.',
      status: 'verified',
      severity: 'blocker',
      source_ids: reputableRegistry.sources.map((source: any) => source.id),
    }], reputableRegistry)
    expect(assertValidEvidencePackage({
      normalized: { searches: [{ tool: 'web_search', sources: [{}, {}], status: 'completed' }] },
      registry: reputableRegistry,
      claims: reputableClaim,
      requireWebSearch: true,
      xSearchPolicy: 'disabled',
      mode: 'contract',
    }).valid).toBe(true)
  })

  it('rejects a one-source Tier B blocker and every X-only blocker', () => {
    const oneSourceRegistry = makePolicyRegistry([{ url: 'https://example-a.test/report' }])
    const oneSourceClaim = bindClaims([{
      id: 'weak',
      claim: 'Only one reputable source.',
      status: 'verified',
      severity: 'blocker',
      source_ids: [oneSourceRegistry.sources[0].id],
    }], oneSourceRegistry)
    expect(validateEvidencePackage({
      normalized: { searches: [{ tool: 'web_search', sources: [{}], status: 'completed' }] },
      registry: oneSourceRegistry,
      claims: oneSourceClaim,
      requireWebSearch: true,
      xSearchPolicy: 'disabled',
      mode: 'contract',
    })).toMatchObject({ valid: false, errors: [expect.stringMatching(/blocker/i)] })

    const xRegistry = makePolicyRegistry([{ url: 'https://x.com/xai/status/1', tool: 'x_search' }])
    const xClaim = bindClaims([{
      id: 'x-only',
      claim: 'X alone cannot block.',
      status: 'verified',
      severity: 'blocker',
      source_ids: [xRegistry.sources[0].id],
    }], xRegistry)
    expect(validateEvidencePackage({
      normalized: { searches: [{ tool: 'x_search', sources: [{}], status: 'completed' }] },
      registry: xRegistry,
      claims: xClaim,
      requireWebSearch: false,
      xSearchPolicy: 'preferred',
      mode: 'landscape',
    })).toMatchObject({ valid: false, errors: [expect.stringMatching(/X-only/i)] })
  })

  it('elevates preferred X only for incidents and never elevates disabled', () => {
    expect(resolveEffectiveXPolicy('preferred', 'incident')).toBe('required')
    expect(resolveEffectiveXPolicy('preferred', 'landscape')).toBe('preferred')
    expect(resolveEffectiveXPolicy('disabled', 'incident')).toBe('disabled')
  })

  it('fails required Web/X gates when the runtime registry has no source-backed event', async () => {
    const xNormalized = normalizeAcpEvents(
      parseAcpJsonl(await readFixture('acp-x-empty-sources.jsonl')),
      { requireComplete: true },
    )
    const xRegistry = buildSourceRegistry(xNormalized, registryOptions())
    expect(validateEvidencePackage({
      normalized: xNormalized,
      registry: xRegistry,
      claims: [],
      requireWebSearch: false,
      xSearchPolicy: 'preferred',
      mode: 'incident',
    })).toMatchObject({ valid: false, errors: [expect.stringMatching(/required X/i)] })

    expect(validateEvidencePackage({
      normalized: { searches: [], turnCompleted: {} },
      registry: { sources: [], searches: [] },
      claims: [],
      requireWebSearch: true,
      xSearchPolicy: 'disabled',
      mode: 'contract',
    })).toMatchObject({ valid: false, errors: [expect.stringMatching(/required Web/i)] })
  })

  it('rejects a registry whose runtime-derived source ID was tampered', () => {
    const registry = makePolicyRegistry([{ url: 'https://docs.x.ai/build/cli/reference' }])
    const tampered = JSON.parse(JSON.stringify(registry))
    tampered.sources[0].id = 'src-0000000000000000'
    expect(validateEvidencePackage({
      normalized: { searches: [{ tool: 'web_search', sources: [{}], status: 'completed' }] },
      registry: tampered,
      claims: [],
      requireWebSearch: true,
      xSearchPolicy: 'disabled',
      mode: 'contract',
    })).toMatchObject({ valid: false, errors: [expect.stringMatching(/runtime-derived ID/i)] })
  })
})
