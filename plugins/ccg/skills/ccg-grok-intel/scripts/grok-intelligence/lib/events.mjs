import {
  INTELLIGENCE_EVENT_SCHEMA_VERSION,
  cloneJson,
  isPlainObject,
  requireNonEmptyString,
} from './contracts.mjs'

const SESSION_UPDATE_METHOD = 'session/update'
const XAI_SESSION_UPDATE_METHOD = '_x.ai/session/update'

export function parseAcpJsonl(text) {
  if (typeof text !== 'string')
    throw new Error('ACP JSONL input must be a string')
  const messages = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim().length === 0)
      continue
    let message
    try {
      message = JSON.parse(line)
    }
    catch {
      throw new Error(`Malformed ACP JSONL at line ${index + 1}`)
    }
    if (!isPlainObject(message))
      throw new Error(`ACP JSONL line ${index + 1} must contain an object`)
    messages.push(message)
  }
  return messages
}

function isXDomainQuery(query) {
  return /(?:^|\s)site:(?:www\.)?(?:x\.com|twitter\.com)\b/i.test(query)
}

function normalizeSource(source, callId) {
  if (!isPlainObject(source) || source.type !== 'url' || typeof source.url !== 'string')
    throw new Error(`WebSearch ${callId} returned a malformed source record`)
  let url
  try {
    url = new URL(source.url)
  }
  catch {
    throw new Error(`WebSearch ${callId} returned an invalid source URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error(`WebSearch ${callId} returned a non-HTTP source URL`)
  return {
    url: source.url,
    ...(typeof source.title === 'string' && source.title.trim() ? { title: source.title.trim() } : {}),
  }
}

function normalizeSearchResult(update, startedCall) {
  const callId = requireNonEmptyString(update.toolCallId, 'tool_call_update.toolCallId')
  const action = update.rawOutput?.action
  const status = typeof update.status === 'string'
    ? update.status
    : typeof update.rawOutput?.status === 'string'
      ? update.rawOutput.status
      : action?.status
  if (status !== 'completed') {
    const query = typeof action?.query === 'string' ? action.query.trim() : ''
    return {
      kind: 'search_error',
      tool: isXDomainQuery(query) ? 'x_search' : 'web_search',
      observed_tool: 'web_search',
      toolCallId: callId,
      query,
      status: status || 'failed',
      sources: [],
      backend: startedCall.backend === true,
      error: String(update.rawOutput?.error || update.error || 'WebSearch failed'),
    }
  }
  if (!isPlainObject(action))
    throw new Error(`WebSearch ${callId} is missing rawOutput.action`)
  const query = requireNonEmptyString(action.query, `WebSearch ${callId} query`)
  if (!Array.isArray(action.sources))
    throw new Error(`WebSearch ${callId} sources must be an array`)
  const tool = isXDomainQuery(query) ? 'x_search' : 'web_search'
  return {
    kind: 'search_result',
    tool,
    observed_tool: 'web_search',
    toolCallId: callId,
    query,
    status,
    sources: action.sources.map(source => normalizeSource(source, callId)),
    backend: startedCall.backend === true,
  }
}

export function normalizeAcpEvents(messages, { requireComplete = true } = {}) {
  if (!Array.isArray(messages))
    throw new Error('ACP messages must be an array')

  const events = []
  const unknownEvents = []
  const searches = []
  const startedCalls = new Map()
  const completedCalls = new Set()
  const agentMessages = []
  let turnCompleted = null

  for (const original of messages) {
    if (!isPlainObject(original))
      throw new Error('ACP event must be an object')
    const message = cloneJson(original)
    if (![SESSION_UPDATE_METHOD, XAI_SESSION_UPDATE_METHOD].includes(message.method)) {
      unknownEvents.push(message)
      continue
    }
    const update = message.params?.update
    if (!isPlainObject(update) || typeof update.sessionUpdate !== 'string') {
      unknownEvents.push(message)
      continue
    }

    switch (update.sessionUpdate) {
      case 'user_message_chunk':
      case 'agent_thought_chunk': {
        const kind = update.sessionUpdate === 'user_message_chunk' ? 'user_message' : 'agent_thought'
        events.push({ kind, text: String(update.content?.text || '') })
        break
      }
      case 'agent_message_chunk': {
        const text = String(update.content?.text || '')
        events.push({ kind: 'agent_message', text })
        agentMessages.push(text)
        break
      }
      case 'tool_call': {
        if (update.rawInput?.variant !== 'WebSearch' || update.kind !== 'search') {
          unknownEvents.push(message)
          break
        }
        const callId = requireNonEmptyString(update.toolCallId, 'tool_call.toolCallId')
        if (startedCalls.has(callId))
          throw new Error(`Duplicate WebSearch tool_call id: ${callId}`)
        const event = {
          kind: 'search_start',
          observed_tool: 'web_search',
          toolCallId: callId,
          status: update.status || 'in_progress',
          backend: update.rawInput.backend === true || update._meta?.backend === true,
        }
        startedCalls.set(callId, event)
        events.push(event)
        break
      }
      case 'tool_call_update': {
        const callId = requireNonEmptyString(update.toolCallId, 'tool_call_update.toolCallId')
        const startedCall = startedCalls.get(callId)
        if (!startedCall)
          throw new Error(`Uncorrelated WebSearch tool_call_update: ${callId}`)
        if (completedCalls.has(callId))
          throw new Error(`Duplicate WebSearch terminal update: ${callId}`)
        const result = normalizeSearchResult(update, startedCall)
        completedCalls.add(callId)
        searches.push(result)
        events.push(result)
        break
      }
      case 'turn_completed': {
        if (turnCompleted)
          throw new Error('Duplicate turn_completed event')
        turnCompleted = {
          stop_reason: update.stop_reason,
          prompt_id: update.prompt_id,
          usage: cloneJson(update.usage || {}),
        }
        events.push({ kind: 'turn_completed', ...turnCompleted })
        break
      }
      default:
        unknownEvents.push(message)
    }
  }

  if (requireComplete) {
    if (!turnCompleted)
      throw new Error('Required ACP stream is truncated or missing turn_completed')
    if (searches.length === 0)
      throw new Error('Required ACP stream contains no completed WebSearch update')
    if (agentMessages.length === 0)
      throw new Error('Required ACP stream contains no final agent message')
    for (const callId of startedCalls.keys()) {
      if (!completedCalls.has(callId))
        throw new Error(`Required ACP stream is truncated before WebSearch ${callId} completed`)
    }
  }

  return {
    schemaVersion: INTELLIGENCE_EVENT_SCHEMA_VERSION,
    events,
    unknownEvents,
    searches,
    finalText: agentMessages.join(''),
    turnCompleted,
  }
}
