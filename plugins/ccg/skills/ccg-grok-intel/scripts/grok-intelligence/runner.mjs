import { createGrokAcpClient } from './lib/acp-client.mjs'
import { buildExactGrokEnvironment } from './lib/exact-env.mjs'
import { normalizeAcpEvents } from './lib/events.mjs'
import { createPrivateRunRoots } from './lib/private-temp.mjs'
import { runGrokDiagnostics } from './lib/process.mjs'
import { buildSourceRegistry } from './lib/source-registry.mjs'
import { createFocusedSnapshot } from './lib/snapshot.mjs'
import { assertValidEvidencePackage } from './lib/validator.mjs'

const EXIT = Object.freeze({ OK: 0, REQUIRED_UNAVAILABLE: 2, UNSAFE: 3, CONFIG: 4 })

function failureText(error, secrets = []) {
  let text = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret)
      text = text.split(secret).join('[REDACTED]')
  }
  return text
    .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bxai-[A-Za-z0-9_-]+/g, '[REDACTED]')
}

function isUnsafe(error) {
  return error?.code === 'unsafe_cli_context' || /unsafe_cli_context|non-empty MCP|mcpToolCount|policy violation/i.test(failureText(error))
}

function isTransient(error) {
  return /(?:429|rate.?limit|temporar|timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|503|502|network)/i.test(failureText(error))
}

function validateTopLevel(options) {
  if (!options || typeof options !== 'object')
    throw new Error('Runner options are required')
  if (!['required', 'preferred', 'disabled'].includes(options.requirement))
    throw new Error('requirement must be required, preferred, or disabled')
  if (options.requirement === 'disabled')
    return
  if (options.consent !== true || options.config?.enabled !== true)
    throw new Error('External intelligence requires explicit user consent and enabled configuration')
  if (!['browser_oauth', 'api_key'].includes(options.config.auth_mode))
    throw new Error('External intelligence authentication is not configured')
  if (options.config.auth_mode === 'api_key' && (typeof options.apiKey !== 'string' || !options.apiKey.trim()))
    throw new Error('External intelligence API key authentication is missing its key')
  if (typeof options.task !== 'string' || !options.task.trim())
    throw new Error('External intelligence task must be non-empty')
}

function buildPrompt({ task, mode, requireWebSearch, xSearchPolicy }) {
  return [
    'You are the external intelligence collector for a software engineering workflow.',
    'Use the built-in WebSearch tool. Do not use files, terminal, MCP, plugins, memory, subagents, or any write tool.',
    'Only state facts supported by URLs returned in WebSearch tool result sources. Never invent or copy a URL from prose.',
    `Mode: ${mode}. Web search required: ${requireWebSearch ? 'yes' : 'no'}. X-domain policy: ${xSearchPolicy}.`,
    'Task:',
    task.trim(),
  ].join('\n')
}

function unavailableResult(requirement, status, reason, attempts, runRoot) {
  return {
    exitCode: requirement === 'required' ? EXIT.REQUIRED_UNAVAILABLE : EXIT.OK,
    status,
    reason,
    attempts,
    ...(runRoot ? { runRoot } : {}),
  }
}

export async function runGrokIntelligence(options) {
  try {
    validateTopLevel(options)
  }
  catch (error) {
    return { exitCode: EXIT.CONFIG, status: 'configuration_required', reason: failureText(error, [options?.apiKey]) }
  }
  if (options.requirement === 'disabled')
    return { exitCode: EXIT.OK, status: 'skipped', reason: 'External intelligence route is disabled' }

  const dependencies = {
    createRoots: options.createPrivateRoots || createPrivateRunRoots,
    createSnapshot: options.createSnapshot || createFocusedSnapshot,
    diagnostics: options.runDiagnostics || runGrokDiagnostics,
    acp: options.runAcp || createGrokAcpClient({ command: options.command || 'grok', prefixArgs: options.prefixArgs || [] }).run,
    cleanup: options.cleanupRunRoots,
  }
  const secrets = [options.apiKey, options.sourceEnv?.HTTPS_PROXY, options.sourceEnv?.HTTP_PROXY]
  let roots
  let result
  let attempts = 0
  try {
    roots = await dependencies.createRoots({
      parent: options.tempParent,
      grokHome: options.grokHome,
      platform: options.platform || process.platform,
    })
    const snapshot = await dependencies.createSnapshot({
      repoRoot: options.repoRoot,
      snapshotRoot: roots.snapshotRoot,
      selectedPaths: options.selectedPaths,
      dirtyDiffs: options.dirtyDiffs,
      limits: options.snapshotLimits || { maxTotalBytes: options.config.max_bundle_bytes || 16 * 1024 * 1024 },
    })
    const env = buildExactGrokEnvironment({
      sourceEnv: options.sourceEnv || {},
      neutralHome: roots.neutralHome,
      grokHome: roots.grokHome,
      apiKey: options.config.auth_mode === 'api_key' ? options.apiKey : undefined,
      platform: options.platform || process.platform,
    })
    const prompt = buildPrompt({
      task: options.task,
      mode: options.mode || 'discover',
      requireWebSearch: options.config.require_web_search !== false,
      xSearchPolicy: options.config.x_search_policy || 'preferred',
    })
    const maxRetries = Math.min(2, Math.max(0, Number.isInteger(options.config.max_retries) ? options.config.max_retries : 2))
    let lastError
    while (attempts <= maxRetries) {
      attempts++
      try {
        await dependencies.diagnostics({
          command: options.command || 'grok',
          prefixArgs: options.prefixArgs || [],
          cwd: roots.neutralHome,
          env,
          timeoutMs: options.diagnosticTimeoutMs,
        })
        const acpOptions = {
          prompt,
          cwd: roots.snapshotRoot,
          allowedCwdRoots: [roots.snapshotRoot],
          neutralHome: roots.neutralHome,
          grokHome: roots.grokHome,
          rawEventsDir: roots.rawEventsDir,
          rawEventsMaxBytes: options.rawEventsMaxBytes ?? 8 * 1024 * 1024,
          rawEventsMaxEvents: options.rawEventsMaxEvents ?? 20000,
          timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
          maxTurns: options.maxTurns ?? 6,
          authMode: options.config.auth_mode,
          apiKey: options.config.auth_mode === 'api_key' ? options.apiKey : undefined,
          sourceEnv: options.sourceEnv || {},
          signal: options.signal,
          attempt: attempts,
        }
        const acpResult = await dependencies.acp(acpOptions)
        if (acpResult?.mcpPreflight?.serversEmpty !== true || acpResult?.mcpPreflight?.toolCount !== 0) {
          const unsafe = new Error('unsafe_cli_context: ACP empty-MCP preflight did not match the pinned contract')
          unsafe.code = 'unsafe_cli_context'
          throw unsafe
        }
        const normalized = normalizeAcpEvents(acpResult.notifications, { requireComplete: true })
        const retrievedAt = (options.clock ? options.clock() : new Date()).toISOString()
        const registry = buildSourceRegistry(normalized, {
          retrievedAt,
          officialDomains: options.officialDomains || ['x.ai', 'docs.x.ai'],
          officialXAccounts: options.officialXAccounts || ['xai', 'grok'],
          domainTiers: options.domainTiers || {},
        })
        const claims = []
        const validation = assertValidEvidencePackage({
          normalized,
          registry,
          claims,
          requireWebSearch: options.config.require_web_search !== false,
          xSearchPolicy: options.config.x_search_policy || 'preferred',
          mode: options.mode || 'discover',
        })
        result = {
          exitCode: EXIT.OK,
          status: 'valid',
          attempts,
          runRoot: roots.runRoot,
          snapshot,
          evidence: { retrieved_at: retrievedAt, normalized, registry, claims, validation },
          raw: { notifications: acpResult.notifications, stderr: acpResult.stderr || [] },
        }
        break
      }
      catch (error) {
        lastError = error
        if (isUnsafe(error)) {
          result = { exitCode: EXIT.UNSAFE, status: 'unsafe_cli_context', reason: failureText(error, secrets), attempts, runRoot: roots.runRoot }
          break
        }
        if (!isTransient(error) || attempts > maxRetries) {
          result = unavailableResult(options.requirement, 'unavailable', failureText(error, secrets), attempts, roots.runRoot)
          break
        }
      }
    }
    result ||= unavailableResult(options.requirement, 'unavailable', failureText(lastError, secrets), attempts, roots.runRoot)
  }
  catch (error) {
    result = isUnsafe(error)
      ? { exitCode: EXIT.UNSAFE, status: 'unsafe_cli_context', reason: failureText(error, secrets), attempts, ...(roots ? { runRoot: roots.runRoot } : {}) }
      : { exitCode: EXIT.UNSAFE, status: 'policy_violation', reason: failureText(error, secrets), attempts, ...(roots ? { runRoot: roots.runRoot } : {}) }
  }

  if (roots) {
    try {
      if (dependencies.cleanup)
        await dependencies.cleanup(roots)
      else
        await roots.cleanup()
    }
    catch (error) {
      return {
        exitCode: EXIT.UNSAFE,
        status: 'cleanup_failed',
        reason: failureText(error, secrets),
        attempts,
        runRoot: roots.runRoot,
      }
    }
  }
  return result
}

export { EXIT as GROK_INTELLIGENCE_EXIT_CODES }
