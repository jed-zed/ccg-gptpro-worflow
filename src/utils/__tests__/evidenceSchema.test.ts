import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

const PACKAGE_ROOT = findPackageRoot()
const TMP_ROOT = join(tmpdir(), `ccg-evidence-${Date.now()}`)
let taskUtils: any

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function makeTask(name: string): { root: string, taskDir: string } {
  const root = join(TMP_ROOT, name)
  const taskDir = join(root, '.ccg', 'tasks', 'demo')
  fs.ensureDirSync(taskDir)
  fs.writeJsonSync(join(taskDir, 'task.json'), {
    id: 'demo',
    status: 'in_progress',
    currentPhase: 'review',
    nextAction: 'review',
  })
  return { root, taskDir }
}

beforeAll(() => {
  fs.ensureDirSync(TMP_ROOT)
  const modulePath = join(TMP_ROOT, 'task-utils.cjs')
  copyFileSync(join(PACKAGE_ROOT, 'templates', 'hooks', 'task-utils.js'), modulePath)
  taskUtils = createRequire(import.meta.url)(modulePath)
})

afterAll(async () => {
  await fs.remove(TMP_ROOT)
})

describe('task evidence helpers', () => {
  it('returns an empty canonical shape when evidence is missing', () => {
    const { taskDir } = makeTask('missing')
    expect(taskUtils.readEvidence(taskDir)).toEqual({ schemaVersion: 1, items: [] })
  })

  it('writes and validates required Gemini evidence', () => {
    const { taskDir } = makeTask('valid-gemini')
    const response = 'Gemini gate review'
    fs.ensureDirSync(join(taskDir, 'evidence'))
    writeFileSync(join(taskDir, 'evidence', 'gemini.md'), response, 'utf-8')

    taskUtils.writeEvidence(taskDir, {
      schemaVersion: 1,
      items: [{
        id: 'gemini-gate-1',
        provider: 'gemini',
        role: 'gate',
        policy: 'required',
        available: true,
        artifactFile: 'evidence/gemini.md',
        artifactSha256: sha256(response),
        artifactChars: response.length,
        summary: 'Gemini found one risk.',
      }],
    })

    const result = taskUtils.validateEvidence(taskDir, {
      provider: 'gemini',
      role: 'gate',
      policy: 'required',
    })
    expect(result.ok).toBe(true)
    expect(result.item.provider).toBe('gemini')
  })

  it('normalizes legacy task.json Gemini evidence for reads', () => {
    const { taskDir } = makeTask('legacy')
    const response = 'Legacy Gemini response'
    fs.ensureDirSync(join(taskDir, 'evidence'))
    writeFileSync(join(taskDir, 'evidence', 'gemini.md'), response, 'utf-8')
    fs.writeJsonSync(join(taskDir, 'task.json'), {
      id: 'demo',
      status: 'in_progress',
      gemini_evidence: {
        required: true,
        role: 'gate',
        available: true,
        response_file: 'evidence/gemini.md',
        response_sha256: sha256(response),
        response_chars: response.length,
        summary: 'legacy summary',
      },
    })

    const evidence = taskUtils.readEvidence(taskDir)
    expect(evidence.items).toHaveLength(1)
    expect(evidence.items[0].provider).toBe('gemini')
    expect(evidence.items[0].role).toBe('gate')
    expect(taskUtils.validateEvidence(taskDir, { provider: 'gemini', role: 'gate' }).ok).toBe(true)
  })

  it('deduplicates appended GPT Pro items by session and round', () => {
    const { taskDir } = makeTask('dedupe')
    fs.ensureDirSync(join(taskDir, 'gptpro', 's1', 'round-1'))
    writeFileSync(join(taskDir, 'gptpro', 's1', 'round-1', 'response.md'), 'Manual response', 'utf-8')

    const item = {
      id: 'gptpro-review-s1-round-1',
      provider: 'gptpro',
      role: 'review',
      policy: 'manual',
      available: true,
      artifactFile: 'gptpro/s1/round-1/response.md',
      sessionId: 's1',
      round: 1,
    }
    taskUtils.appendEvidenceItem(taskDir, item)
    taskUtils.appendEvidenceItem(taskDir, { ...item, summary: 'updated' })

    const evidence = taskUtils.readEvidence(taskDir)
    expect(evidence.items).toHaveLength(1)
    expect(evidence.items[0].summary).toBe('updated')
  })

  it('does not block when optional evidence is missing', () => {
    const { taskDir } = makeTask('optional')
    const result = taskUtils.validateEvidence(taskDir, {
      provider: 'gptpro',
      role: 'review',
      policy: 'optional',
    })
    expect(result).toMatchObject({ ok: true, reason: 'optional_evidence_missing' })
  })

  it('rejects a hash mismatch for available evidence', () => {
    const { taskDir } = makeTask('hash-mismatch')
    fs.ensureDirSync(join(taskDir, 'evidence'))
    writeFileSync(join(taskDir, 'evidence', 'gemini.md'), 'changed bytes', 'utf-8')
    taskUtils.writeEvidence(taskDir, {
      schemaVersion: 1,
      items: [{
        id: 'gemini-gate-1',
        provider: 'gemini',
        role: 'gate',
        policy: 'required',
        available: true,
        artifactFile: 'evidence/gemini.md',
        artifactSha256: sha256('original bytes'),
      }],
    })

    expect(taskUtils.validateEvidence(taskDir, { provider: 'gemini', role: 'gate' }))
      .toMatchObject({ ok: false, reason: 'artifact_hash_mismatch' })
  })
})
