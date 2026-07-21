import { describe, expect, it } from 'vitest'
import { buildGrokDoctorArguments, execSafe, validateIntelligenceDoctorConfig } from '../../commands/doctor'

describe('doctor command helpers', () => {
  it('executes child commands from the ESM CLI', () => {
    expect(execSafe(`"${process.execPath}" --version`)).toBe(process.version)
  })

  it('keeps local and paid Grok doctor modes explicitly split', () => {
    expect(buildGrokDoctorArguments({ grok: true })).toEqual(['doctor', '--json'])
    expect(buildGrokDoctorArguments({ grokLive: true })).toEqual(['doctor', '--json', '--live'])
    expect(buildGrokDoctorArguments({ grok: true, grokCleanup: true })).toEqual(['doctor', '--json', '--cleanup'])
  })

  it('rejects provider fallback and incompatible intelligence config', () => {
    expect(validateIntelligenceDoctorConfig({
      provider: 'grok-cli', transport: 'acp', auth_mode: 'browser_oauth',
      legacy_search_provider: 'grok-search-mcp', allow_provider_fallback: false,
    })).toEqual([])
    expect(validateIntelligenceDoctorConfig({
      provider: 'other', transport: 'headless', auth_mode: 'cookie',
      legacy_search_provider: 'other', allow_provider_fallback: true,
    })).toHaveLength(5)
  })
})
