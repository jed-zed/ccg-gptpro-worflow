import type { ProviderExecution } from '../provider-registry'
import type { PRODUCT_MANAGER_OUTPUT_JSON_SCHEMA } from '../contracts'
import { validateProviderExecution } from '../provider-registry'

export function createClaudeProductManagerExecution(executable: string, options: {
  model: string
  schema: typeof PRODUCT_MANAGER_OUTPUT_JSON_SCHEMA
}): ProviderExecution {
  return validateProviderExecution({
    executable,
    args: [
      '--safe-mode',
      '--disable-slash-commands',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--settings',
      '{}',
      '--no-session-persistence',
      '--no-chrome',
      '--permission-mode',
      'plan',
      '--input-format',
      'text',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(options.schema),
      '--model',
      options.model,
      '--system-prompt',
      [
        'You are a read-only product-manager reviewer.',
        'Do not use tools, files, commands, MCP servers, hooks, skills, plugins, or subagents.',
        'Return only the structured object required by the supplied JSON Schema.',
      ].join(' '),
      '--print',
    ],
    environmentKeys: [],
    readOnly: true,
    shell: false,
  })
}
