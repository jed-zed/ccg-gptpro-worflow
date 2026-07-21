import fs from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function readJson(path: string): any {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

describe('Codex plugin release parity', () => {
  it('keeps plugin marketplace versions aligned with the package release', () => {
    const packageVersion = readJson(join(root, 'package.json')).version
    const pluginVersion = readJson(join(root, 'plugins', 'ccg', '.codex-plugin', 'plugin.json')).version
    const codexMarketplaceVersion = readJson(join(root, '.codex-plugin', 'marketplace.json')).plugins[0].version
    const claudeMarketplaceVersion = readJson(join(root, '.claude-plugin', 'marketplace.json')).plugins[0].version

    expect(pluginVersion).toBe(packageVersion)
    expect(codexMarketplaceVersion).toBe(packageVersion)
    expect(claudeMarketplaceVersion).toBe(packageVersion)
  })

  it('keeps the repository preview helper at feature parity with the installed live preview', () => {
    const preview = fs.readFileSync(
      join(root, 'plugins', 'ccg', 'skills', 'ccg-executor', 'scripts', 'invoke_gemini_preview.py'),
      'utf8',
    )

    expect(preview).toContain('preview_session_id')
    expect(preview).toContain('/api/sessions')
    expect(preview).toContain('/api/stream/')
    expect(preview).toContain('STATE.complete(')
  })

  it('keeps the Grok routing runtime and coverage manifest byte-identical across distributions', () => {
    const pairs = [
      [
        join(root, 'templates', 'engine', 'tools', 'grok-intelligence', 'route.mjs'),
        join(root, 'plugins', 'ccg', 'skills', 'ccg-grok-intel', 'scripts', 'grok-intelligence', 'route.mjs'),
      ],
      [
        join(root, 'templates', 'engine', 'tools', 'grok-intelligence', 'workflow-coverage.json'),
        join(root, 'plugins', 'ccg', 'skills', 'ccg-grok-intel', 'scripts', 'grok-intelligence', 'workflow-coverage.json'),
      ],
    ]
    for (const [template, plugin] of pairs)
      expect(fs.readFileSync(plugin, 'utf8'), plugin).toBe(fs.readFileSync(template, 'utf8'))
  })
})
