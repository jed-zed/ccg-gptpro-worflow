import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'fs-extra'

function findPackageRoot(): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, 'package.json'))
      return dir
    }
    catch {
      dir = join(dir, '..')
    }
  }
  throw new Error('Could not find package root')
}

interface PythonCommand {
  command: string
  prefixArgs: string[]
}

function findPython(): PythonCommand | null {
  for (const candidate of [
    { command: 'python', prefixArgs: [] },
    { command: 'py', prefixArgs: ['-3'] },
  ]) {
    try {
      execFileSync(candidate.command, [...candidate.prefixArgs, '--version'], { stdio: 'pipe' })
      return candidate
    }
    catch {
      // Try next candidate.
    }
  }
  return null
}

function runPython(python: PythonCommand, args: string[], cwd?: string): string {
  return execFileSync(python.command, [...python.prefixArgs, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function parseOutputPath(output: string, key: string): string {
  const line = output.split(/\r?\n/).find(item => item.startsWith(`${key}=`))
  if (!line) throw new Error(`Missing output key: ${key}\n${output}`)
  return line.slice(key.length + 1).trim()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function writeGeminiGateEvidence(taskDir: string, artifactFile: string, response: string): void {
  fs.writeJsonSync(join(taskDir, 'evidence.json'), {
    schemaVersion: 1,
    items: [{
      id: 'gemini-gate-1',
      provider: 'gemini',
      role: 'gate',
      policy: 'required',
      available: true,
      artifactFile,
      artifactSha256: sha256(response),
      artifactChars: response.length,
      summary: 'Gemini gate evidence is available.',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  })
}

function writeRoutingEvidence(
  evidenceDir: string,
  claudeEvidenceStatus: string | null = 'automatic',
): { evidenceFile: string, summaryFile: string, content: string, summary: string } {
  const content = [
    'ordinary /ccg:review first',
    'current orchestrator: codex',
    'routed models: codex primary review, gemini gate evidence',
    ...(claudeEvidenceStatus ? [`claudeEvidenceStatus: ${claudeEvidenceStatus}`] : []),
    'ordinary review conclusion: packaging path needs verification',
  ].join('\n')
  const summary = 'Ordinary review route completed with Codex primary review and Gemini gate evidence.'
  const evidenceFile = join(evidenceDir, 'routing.md')
  const summaryFile = join(evidenceDir, 'routing-summary.md')
  writeFileSync(evidenceFile, content, 'utf-8')
  writeFileSync(summaryFile, summary, 'utf-8')
  return { evidenceFile, summaryFile, content, summary }
}

function runPythonFailure(python: PythonCommand, args: string[], cwd?: string): string {
  try {
    runPython(python, args, cwd)
  }
  catch (error: any) {
    return String(error.stderr || error.message || error)
  }
  throw new Error('Expected Python command to fail')
}

const PACKAGE_ROOT = findPackageRoot()
const BRIDGE = join(PACKAGE_ROOT, 'templates', 'engine', 'tools', 'gptpro', 'gptpro_bridge.py')
const TMP_ROOT = join(tmpdir(), `ccg-gptpro-bridge-${Date.now()}`)
const PYTHON = findPython()
const maybeIt = PYTHON ? it : it.skip

afterAll(async () => {
  await fs.remove(TMP_ROOT)
  await fs.remove(join(PACKAGE_ROOT, 'templates', 'engine', 'tools', 'gptpro', '__pycache__'))
})

describe('GPT Pro manual bridge', () => {
  maybeIt('passes Python syntax compilation', () => {
    runPython(PYTHON!, ['-m', 'py_compile', BRIDGE])
  })

  it('mode templates include explicit GPT Pro task directives', () => {
    const templateDir = join(PACKAGE_ROOT, 'templates', 'engine', 'tools', 'gptpro', 'templates')
    const plan = readFileSync(join(templateDir, 'plan.md'), 'utf-8')
    const review = readFileSync(join(templateDir, 'review.md'), 'utf-8')
    const exc = readFileSync(join(templateDir, 'exc.md'), 'utf-8')

    expect(plan).toContain('## Task For GPT Pro')
    expect(plan).toContain('review the current plan for requirement ambiguity')
    expect(plan).toContain('implementation details that should be added to the plan')
    expect(review).toContain('## Task For GPT Pro')
    expect(review).toContain('review the submitted scope for concrete defects')
    expect(review).toContain('specific tests or verification needed before merge')
    expect(exc).toContain('## Task For GPT Pro')
    expect(exc).toContain('decide whether the current execution route should proceed')
    expect(exc).toContain('supplement the route with')
  })

  maybeIt('creates task-local review artifacts and records saved response evidence', () => {
    const root = join(TMP_ROOT, 'review-session')
    const taskDir = join(root, '.ccg', 'tasks', 'demo-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), {
      id: 'demo-task',
      status: 'in_progress',
      currentPhase: 'review',
      nextAction: 'run GPT Pro review',
    })
    const geminiResponse = 'Gemini gate evidence: review the packaging path.'
    writeFileSync(join(evidenceDir, 'gemini.md'), geminiResponse, 'utf-8')
    writeFileSync(join(evidenceDir, 'gemini-summary.md'), 'Gemini says packaging must be checked.', 'utf-8')
    writeGeminiGateEvidence(taskDir, 'evidence/gemini.md', geminiResponse)
    const routing = writeRoutingEvidence(evidenceDir)

    const output = runPython(PYTHON!, [
      BRIDGE,
      '--mode',
      'review',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/demo-task',
      '--source-command',
      '/ccg:gptpro-review',
      '--prompt',
      'Review this migration.',
      '--slug',
      'demo-task-review',
      '--gemini-policy',
      'required',
      '--gemini-evidence-role',
      'gate',
      '--gemini-response-file',
      join(evidenceDir, 'gemini.md'),
      '--gemini-summary-file',
      join(evidenceDir, 'gemini-summary.md'),
      '--routing-evidence-file',
      routing.evidenceFile,
      '--routing-summary-file',
      routing.summaryFile,
      '--require-routing-evidence',
      '--require-claude-evidence',
    ], root)

    const statusFile = parseOutputPath(output, 'CCG_GPTPRO_STATUS_FILE')
    const promptFile = parseOutputPath(output, 'CCG_GPTPRO_PROMPT_FILE')
    const status = fs.readJsonSync(statusFile)
    expect(status.session_dir).toContain('.ccg/tasks/demo-task/gptpro/')
    expect(status.task_dir).toBe('.ccg/tasks/demo-task')
    expect(status.evidence_file).toBe('.ccg/tasks/demo-task/evidence.json')
    expect(status.source_command).toBe('/ccg:gptpro-review')
    expect(status.routing_evidence).toMatchObject({
      required: true,
      available: true,
      evidence_file: '.ccg/tasks/demo-task/evidence/routing.md',
      evidence_sha256: sha256(routing.content),
      evidence_chars: routing.content.length,
      summary_file: '.ccg/tasks/demo-task/evidence/routing-summary.md',
      summary: routing.summary,
      summary_chars: routing.summary.length,
      claudeEvidenceStatus: 'automatic',
    })
    const promptText = readFileSync(promptFile, 'utf-8')
    expect(promptText).toContain('Project Access Context')
    expect(promptText).toContain('Repository URL: not provided')
    expect(promptText).toContain('Current branch: unknown')
    expect(promptText).toContain('Current commit: unknown')
    expect(promptText).toContain('Local git status: not_git')
    expect(promptText).toContain('High-Value Review Second Opinion')
    expect(promptText).toContain('Task For GPT Pro')
    expect(promptText).toContain('review the submitted scope for concrete defects')
    expect(promptText).toContain('specific tests or verification needed before merge')
    expect(promptText).toContain('Critical')
    expect(promptText).toContain('False Positives')
    expect(promptText).toContain('Required Tests')
    expect(promptText).toContain('Base CCG Routing Evidence')
    expect(promptText).toContain('Routing evidence file: .ccg/tasks/demo-task/evidence/routing.md')
    expect(promptText).toContain('Claude evidence status: automatic')
    expect(promptText).toContain(routing.summary)

    const saveScript = [
      'import importlib.util, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("gptpro_bridge", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec)',
      'sys.modules["gptpro_bridge"] = mod',
      'spec.loader.exec_module(mod)',
      'session = mod.load_session(pathlib.Path(sys.argv[2]).parent)',
      'mod.save_response(session, "Manual GPT Pro response\\n")',
    ].join('; ')
    runPython(PYTHON!, ['-c', saveScript, BRIDGE, statusFile], root)

    const updatedStatus = fs.readJsonSync(statusFile)
    const roundStatus = updatedStatus.rounds['round-1']
    expect(roundStatus.response_saved).toBe(true)
    expect(roundStatus.response_sha256).toMatch(/^[a-f0-9]{64}$/)

    const evidence = fs.readJsonSync(join(taskDir, 'evidence.json'))
    const gptproEvidence = evidence.items.find((item: any) => item.provider === 'gptpro')
    expect(evidence.items).toHaveLength(2)
    expect(gptproEvidence).toMatchObject({
      provider: 'gptpro',
      role: 'review',
      available: true,
      artifactFile: expect.stringContaining('round-1/response.md'),
    })
    expect(gptproEvidence.artifactSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(gptproEvidence.artifactChars).toBe('Manual GPT Pro response\n'.length)
  })

  maybeIt('inherits required routing evidence for follow-up sessions without fresh routing files', () => {
    const root = join(TMP_ROOT, 'routing-followup-session')
    const taskDir = join(root, '.ccg', 'tasks', 'followup-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), {
      id: 'followup-task',
      status: 'in_progress',
      currentPhase: 'review',
      nextAction: 'run GPT Pro follow-up review',
    })
    const geminiResponse = 'Gemini gate evidence: review follow-up inheritance.'
    writeFileSync(join(evidenceDir, 'gemini.md'), geminiResponse, 'utf-8')
    writeFileSync(join(evidenceDir, 'gemini-summary.md'), 'Gemini says follow-up inheritance is relevant.', 'utf-8')
    writeGeminiGateEvidence(taskDir, 'evidence/gemini.md', geminiResponse)
    const routing = writeRoutingEvidence(evidenceDir)

    const roundOneOutput = runPython(PYTHON!, [
      BRIDGE,
      '--mode',
      'review',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/followup-task',
      '--prompt',
      'Review round one.',
      '--slug',
      'followup-task-review',
      '--gemini-response-file',
      join(evidenceDir, 'gemini.md'),
      '--gemini-summary-file',
      join(evidenceDir, 'gemini-summary.md'),
      '--routing-evidence-file',
      routing.evidenceFile,
      '--routing-summary-file',
      routing.summaryFile,
      '--require-routing-evidence',
      '--require-claude-evidence',
    ], root)
    const sessionDir = parseOutputPath(roundOneOutput, 'CCG_GPTPRO_SESSION_DIR')

    const roundTwoOutput = runPython(PYTHON!, [
      BRIDGE,
      '--mode',
      'review',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/followup-task',
      '--prompt',
      'Review round two without fresh routing files.',
      '--followup-session',
      sessionDir,
      '--followup-reason',
      'Re-check after revised review notes.',
      '--require-routing-evidence',
      '--require-claude-evidence',
    ], root)
    const statusFile = parseOutputPath(roundTwoOutput, 'CCG_GPTPRO_STATUS_FILE')
    const promptFile = parseOutputPath(roundTwoOutput, 'CCG_GPTPRO_PROMPT_FILE')
    const status = fs.readJsonSync(statusFile)

    expect(status.current_round).toBe(2)
    expect(status.rounds['round-2']).toBeDefined()
    expect(status.routing_evidence).toMatchObject({
      required: true,
      available: true,
      inherited_from_round: 1,
      evidence_file: '.ccg/tasks/followup-task/evidence/routing.md',
      summary: routing.summary,
      claudeEvidenceStatus: 'automatic',
    })
    const promptText = readFileSync(promptFile, 'utf-8')
    expect(promptText).toContain('Base CCG Routing Evidence')
    expect(promptText).toContain('Routing evidence file: .ccg/tasks/followup-task/evidence/routing.md')
    expect(promptText).toContain('Claude evidence status: automatic')
    expect(promptText).toContain(routing.summary)
  })

  maybeIt('rejects required Claude evidence when routing evidence lacks a valid status', () => {
    const root = join(TMP_ROOT, 'missing-claude-status')
    const taskDir = join(root, '.ccg', 'tasks', 'missing-claude-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), { id: 'missing-claude-task', status: 'in_progress' })
    const routing = writeRoutingEvidence(evidenceDir, null)

    const stderr = runPythonFailure(PYTHON!, [
      BRIDGE,
      '--mode',
      'exc',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/missing-claude-task',
      '--prompt',
      'Create a manual GPT Pro execution route review.',
      '--gemini-policy',
      'optional',
      '--gemini-evidence-role',
      'frontend-prototype',
      '--routing-evidence-file',
      routing.evidenceFile,
      '--routing-summary-file',
      routing.summaryFile,
      '--require-routing-evidence',
      '--require-claude-evidence',
    ], root)
    expect(stderr).toContain('claudeEvidenceStatus is required')
  })

  maybeIt('records execution route review metadata while preserving the legacy evidence role', () => {
    const root = join(TMP_ROOT, 'execution-route-review-evidence')
    const taskDir = join(root, '.ccg', 'tasks', 'route-review-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), { id: 'route-review-task', status: 'in_progress' })
    const routing = writeRoutingEvidence(evidenceDir, 'manual_handoff')

    const output = runPython(PYTHON!, [
      BRIDGE,
      '--mode',
      'exc',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/route-review-task',
      '--prompt',
      'Create a manual GPT Pro execution route review.',
      '--slug',
      'route-review-task-exc',
      '--gemini-policy',
      'optional',
      '--gemini-evidence-role',
      'frontend-prototype',
      '--routing-evidence-file',
      routing.evidenceFile,
      '--routing-summary-file',
      routing.summaryFile,
      '--require-routing-evidence',
      '--require-claude-evidence',
    ], root)

    const statusFile = parseOutputPath(output, 'CCG_GPTPRO_STATUS_FILE')
    const promptFile = parseOutputPath(output, 'CCG_GPTPRO_PROMPT_FILE')
    const status = fs.readJsonSync(statusFile)
    expect(status.routing_evidence).toMatchObject({
      required: true,
      available: true,
      claudeEvidenceStatus: 'manual_handoff',
    })
    const promptText = readFileSync(promptFile, 'utf-8')
    expect(promptText).toContain('Task For GPT Pro')
    expect(promptText).toContain('decide whether the current execution route should proceed')
    expect(promptText).toContain('supplement the route with')

    const saveScript = [
      'import importlib.util, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("gptpro_bridge", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec)',
      'sys.modules["gptpro_bridge"] = mod',
      'spec.loader.exec_module(mod)',
      'session = mod.load_session(pathlib.Path(sys.argv[2]).parent)',
      'mod.save_response(session, "Manual GPT Pro execution route review response\\n")',
    ].join('; ')
    runPython(PYTHON!, ['-c', saveScript, BRIDGE, statusFile], root)

    const evidence = fs.readJsonSync(join(taskDir, 'evidence.json'))
    const gptproEvidence = evidence.items.find((item: any) => item.provider === 'gptpro')
    expect(gptproEvidence).toMatchObject({
      provider: 'gptpro',
      role: 'execution-companion',
      displayRole: 'execution-route-review',
      semanticRole: 'route-review',
      implementationOwner: false,
      available: true,
      artifactFile: expect.stringContaining('round-1/response.md'),
    })
    expect(gptproEvidence.summary).toContain('execution route review response saved')
  })

  maybeIt('rejects an empty saved response', () => {
    const root = join(TMP_ROOT, 'empty-response')
    const taskDir = join(root, '.ccg', 'tasks', 'empty-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), { id: 'empty-task', status: 'in_progress' })
    const geminiResponse = 'Gemini evidence'
    writeFileSync(join(evidenceDir, 'gemini.md'), geminiResponse, 'utf-8')
    writeGeminiGateEvidence(taskDir, 'evidence/gemini.md', geminiResponse)

    const output = runPython(PYTHON!, [
      BRIDGE,
      '--mode',
      'review',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/empty-task',
      '--prompt',
      'Review this empty response guard.',
      '--gemini-response-file',
      join(evidenceDir, 'gemini.md'),
      '--gemini-summary',
      'Gemini evidence is available.',
    ], root)
    const statusFile = parseOutputPath(output, 'CCG_GPTPRO_STATUS_FILE')
    const emptyScript = [
      'import importlib.util, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("gptpro_bridge", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec)',
      'sys.modules["gptpro_bridge"] = mod',
      'spec.loader.exec_module(mod)',
      'session = mod.load_session(pathlib.Path(sys.argv[2]).parent)',
      'try:',
      '    mod.save_response(session, "   ")',
      'except ValueError:',
      '    sys.exit(0)',
      'sys.exit(1)',
    ].join('\n')
    runPython(PYTHON!, ['-c', emptyScript, BRIDGE, statusFile], root)
  })

  maybeIt('rejects plan/review sessions without canonical Gemini gate evidence', () => {
    const root = join(TMP_ROOT, 'missing-canonical-gemini')
    const taskDir = join(root, '.ccg', 'tasks', 'missing-gate-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), { id: 'missing-gate-task', status: 'in_progress' })
    writeFileSync(join(evidenceDir, 'gemini.md'), 'Gemini evidence without canonical item', 'utf-8')

    const stderr = runPythonFailure(PYTHON!, [
      BRIDGE,
      '--mode',
      'review',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/missing-gate-task',
      '--prompt',
      'Review canonical evidence enforcement.',
      '--gemini-response-file',
      join(evidenceDir, 'gemini.md'),
      '--gemini-summary',
      'Gemini evidence is available.',
    ], root)
    expect(stderr).toContain('Canonical Gemini gate evidence file not found')
  })

  maybeIt('rejects required routing evidence when the file is missing', () => {
    const root = join(TMP_ROOT, 'missing-routing-evidence')
    const taskDir = join(root, '.ccg', 'tasks', 'missing-routing-task')
    fs.ensureDirSync(taskDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), { id: 'missing-routing-task', status: 'in_progress' })

    const stderr = runPythonFailure(PYTHON!, [
      BRIDGE,
      '--mode',
      'exc',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/missing-routing-task',
      '--prompt',
      'Create a manual GPT Pro execution second opinion.',
      '--gemini-policy',
      'optional',
      '--gemini-evidence-role',
      'frontend-prototype',
      '--require-routing-evidence',
    ], root)
    expect(stderr).toContain('Base CCG routing evidence file is required')
  })

  maybeIt('protects preview write endpoints with a token and response size limit', () => {
    const root = join(TMP_ROOT, 'preview-protection')
    const taskDir = join(root, '.ccg', 'tasks', 'preview-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), { id: 'preview-task', status: 'in_progress' })
    const geminiResponse = 'Gemini gate evidence for preview protection.'
    writeFileSync(join(evidenceDir, 'gemini.md'), geminiResponse, 'utf-8')
    writeGeminiGateEvidence(taskDir, 'evidence/gemini.md', geminiResponse)

    const output = runPython(PYTHON!, [
      BRIDGE,
      '--mode',
      'review',
      '--workdir',
      root,
      '--task-dir',
      '.ccg/tasks/preview-task',
      '--prompt',
      'Review preview protection.',
      '--gemini-response-file',
      join(evidenceDir, 'gemini.md'),
      '--gemini-summary',
      'Gemini evidence is available.',
    ], root)
    const statusFile = parseOutputPath(output, 'CCG_GPTPRO_STATUS_FILE')
    const serverScript = [
      'import http.client, importlib.util, json, pathlib, sys',
      'spec = importlib.util.spec_from_file_location("gptpro_bridge", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec)',
      'sys.modules["gptpro_bridge"] = mod',
      'spec.loader.exec_module(mod)',
      'session = mod.load_session(pathlib.Path(sys.argv[2]).parent)',
      'server, url = mod.start_server(session, port=0)',
      'port = server.server_address[1]',
      'def post(headers, body):',
      '    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)',
      '    conn.request("POST", "/save-response", body=body, headers=headers)',
      '    response = conn.getresponse()',
      '    print(response.status)',
      '    response.read()',
      '    conn.close()',
      'def post_declared_length(headers, length):',
      '    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)',
      '    conn.putrequest("POST", "/save-response")',
      '    for key, value in headers.items():',
      '        conn.putheader(key, value)',
      '    conn.putheader("Content-Length", str(length))',
      '    conn.endheaders()',
      '    response = conn.getresponse()',
      '    print(response.status)',
      '    response.read()',
      '    conn.close()',
      'try:',
      '    post({"Content-Type": "application/json"}, json.dumps({"response": "spoof"}).encode("utf-8"))',
      '    token = session.status()["preview_token"]',
      '    post_declared_length({"Content-Type": "application/json", "X-CCG-GPTPRO-Token": token}, -1)',
      '    post_declared_length({"Content-Type": "application/json", "X-CCG-GPTPRO-Token": token}, mod.MAX_RESPONSE_BYTES + 1)',
      '    post({"Content-Type": "application/json", "X-CCG-GPTPRO-Token": token}, json.dumps({"response": "Manual response"}).encode("utf-8"))',
      'finally:',
      '    server.shutdown()',
      '    server.server_close()',
    ].join('\n')
    const result = runPython(PYTHON!, ['-c', serverScript, BRIDGE, statusFile], root)
    expect(result.trim().split(/\r?\n/)).toEqual(['403', '400', '413', '200'])
  })
})
