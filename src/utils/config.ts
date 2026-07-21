import type { CcgConfig, IntelligenceConfig, ModelRouting, SupportedLang } from '../types'
import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { parse, stringify } from 'smol-toml'
import { version as packageVersion } from '../../package.json'

// v1.4.0: 配置目录统一到 ~/.claude/.ccg/
const CCG_DIR = join(homedir(), '.claude', '.ccg')
const CONFIG_FILE = join(CCG_DIR, 'config.toml')

export function getCcgDir(): string {
  return CCG_DIR
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export async function ensureCcgDir(): Promise<void> {
  await fs.ensureDir(CCG_DIR)
}

export async function readCcgConfig(): Promise<CcgConfig | null> {
  try {
    if (await fs.pathExists(CONFIG_FILE)) {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8')
      return parse(content) as unknown as CcgConfig
    }
  }
  catch {
    // Config doesn't exist or is invalid
  }
  return null
}

export async function writeCcgConfig(config: CcgConfig): Promise<void> {
  await ensureCcgDir()
  const content = stringify(config as any)
  await fs.writeFile(CONFIG_FILE, content, 'utf-8')
}

const DEFAULT_INTELLIGENCE_CONFIG: IntelligenceConfig = {
  enabled: false,
  auto_route: false,
  provider: 'grok-cli',
  transport: 'acp',
  auth_mode: 'browser_oauth',
  legacy_search_provider: 'grok-search-mcp',
  allow_provider_fallback: false,
  default_model: 'grok-4.5',
  deep_research_model: '',
  deep_research_enabled: false,
  live_checks_on_init: false,
  artifact_root: '.codex/ccg/intelligence',
  max_retries: 2,
  max_bundle_bytes: 16 * 1024 * 1024,
  retention_days: 7,
  exported_retention_days: 30,
  cleanup_credential_artifacts: true,
  require_web_search: true,
  x_search_policy: 'preferred',
}

export function normalizeIntelligenceConfig(
  value: Partial<IntelligenceConfig> | undefined,
  options: { existingInstall: boolean, explicitConsent?: boolean },
): IntelligenceConfig {
  const configuredEnabled = options.existingInstall && value?.enabled === true
  const enabled = options.explicitConsent ?? configuredEnabled
  const authMode = value?.auth_mode === 'api_key' ? 'api_key' : 'browser_oauth'
  const xSearchPolicy = value?.x_search_policy === 'required' || value?.x_search_policy === 'disabled'
    ? value.x_search_policy
    : 'preferred'

  return {
    ...DEFAULT_INTELLIGENCE_CONFIG,
    default_model: value?.default_model || DEFAULT_INTELLIGENCE_CONFIG.default_model,
    deep_research_model: value?.deep_research_model || DEFAULT_INTELLIGENCE_CONFIG.deep_research_model,
    max_retries: value?.max_retries ?? DEFAULT_INTELLIGENCE_CONFIG.max_retries,
    max_bundle_bytes: value?.max_bundle_bytes ?? DEFAULT_INTELLIGENCE_CONFIG.max_bundle_bytes,
    retention_days: value?.retention_days ?? DEFAULT_INTELLIGENCE_CONFIG.retention_days,
    exported_retention_days: value?.exported_retention_days ?? DEFAULT_INTELLIGENCE_CONFIG.exported_retention_days,
    require_web_search: value?.require_web_search ?? DEFAULT_INTELLIGENCE_CONFIG.require_web_search,
    enabled,
    auto_route: enabled && (options.explicitConsent === true || value?.auto_route === true),
    auth_mode: authMode,
    x_search_policy: xSearchPolicy,
  }
}

export function resolveNonInteractiveIntelligenceConsent(
  value: Partial<IntelligenceConfig> | undefined,
  explicitFlag: boolean | undefined,
): boolean {
  return explicitFlag ?? (value?.enabled === true)
}

export function resolveCliIntelligenceFlag(argv: string[]): boolean | undefined {
  let resolved: boolean | undefined
  for (const argument of argv) {
    if (argument === '--intelligence')
      resolved = true
    else if (argument === '--no-intelligence')
      resolved = false
  }
  return resolved
}

export function createDefaultConfig(options: {
  language: SupportedLang
  routing: ModelRouting
  installedWorkflows: string[]
  mcpProvider?: string
  liteMode?: boolean
  skipImpeccable?: boolean
  intelligenceConsent?: boolean
  intelligence?: Partial<IntelligenceConfig>
  existingInstall?: boolean
}): CcgConfig {
  return {
    general: {
      version: packageVersion,
      language: options.language,
      createdAt: new Date().toISOString(),
    },
    routing: options.routing,
    workflows: {
      installed: options.installedWorkflows,
    },
    paths: {
      commands: join(homedir(), '.claude', 'commands', 'ccg'),
      prompts: join(CCG_DIR, 'prompts'), // v1.4.0: 移到配置目录
      backup: join(CCG_DIR, 'backup'),
    },
    mcp: {
      provider: options.mcpProvider || 'fast-context',
      setup_url: 'https://augmentcode.com/',
    },
    intelligence: normalizeIntelligenceConfig(options.intelligence, {
      existingInstall: options.existingInstall ?? false,
      explicitConsent: options.intelligenceConsent,
    }),
    performance: {
      liteMode: options.liteMode || false,
      skipImpeccable: options.skipImpeccable || false,
    },
  }
}

export function createDefaultRouting(): ModelRouting {
  return {
    frontend: {
      models: ['gemini'],
      primary: 'gemini',
      strategy: 'parallel',
    },
    backend: {
      models: ['codex'],
      primary: 'codex',
      strategy: 'parallel',
    },
    review: {
      models: ['codex', 'gemini'],
      strategy: 'parallel',
    },
    mode: 'smart',
  }
}
