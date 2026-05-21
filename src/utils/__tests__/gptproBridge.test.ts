import { execFileSync } from 'node:child_process'
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
    ], root)

    const statusFile = parseOutputPath(output, 'CCG_GPTPRO_STATUS_FILE')
    const promptFile = parseOutputPath(output, 'CCG_GPTPRO_PROMPT_FILE')
    const status = fs.readJsonSync(statusFile)
    expect(status.session_dir).toContain('.ccg/tasks/demo-task/gptpro/')
    expect(status.task_dir).toBe('.ccg/tasks/demo-task')
    expect(status.evidence_file).toBe('.ccg/tasks/demo-task/evidence.json')
    expect(status.source_command).toBe('/ccg:gptpro-review')
    expect(readFileSync(promptFile, 'utf-8')).toContain('Project Access Context')

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
    expect(evidence.items).toHaveLength(1)
    expect(evidence.items[0]).toMatchObject({
      provider: 'gptpro',
      role: 'review',
      available: true,
      artifactFile: expect.stringContaining('round-1/response.md'),
    })
    expect(evidence.items[0].artifactSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  maybeIt('rejects an empty saved response', () => {
    const root = join(TMP_ROOT, 'empty-response')
    const taskDir = join(root, '.ccg', 'tasks', 'empty-task')
    const evidenceDir = join(taskDir, 'evidence')
    fs.ensureDirSync(evidenceDir)
    fs.writeJsonSync(join(taskDir, 'task.json'), { id: 'empty-task', status: 'in_progress' })
    writeFileSync(join(evidenceDir, 'gemini.md'), 'Gemini evidence', 'utf-8')

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
})
