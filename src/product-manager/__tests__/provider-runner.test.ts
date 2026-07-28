import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeReadOnlyProvider } from '../provider-runner'

const cleanupPids = new Set<number>()

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate())
      return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return predicate()
}

afterEach(() => {
  for (const pid of cleanupPids) {
    if (processIsAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {
        // Best-effort cleanup for an already-exited regression-test process.
      }
    }
  }
  cleanupPids.clear()
})

describe('product-manager provider runner', () => {
  it('terminates the provider process tree when the call times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccg-provider-runner-'))
    const descendantPidFile = join(root, 'descendant.pid')
    const descendant = 'setInterval(() => {}, 1000)'
    const parent = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });`,
      'writeFileSync(process.argv[1], String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('')

    try {
      await expect(executeReadOnlyProvider({
        execution: {
          executable: process.execPath,
          args: ['-e', parent, descendantPidFile],
          readOnly: true,
          shell: false,
        },
        cwd: root,
        input: '',
        timeoutMs: 100,
        maxOutputBytes: 1024,
      })).rejects.toThrow(/timed out/i)

      expect(existsSync(descendantPidFile)).toBe(true)
      const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'))
      cleanupPids.add(descendantPid)
      expect(await waitFor(() => !processIsAlive(descendantPid))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
