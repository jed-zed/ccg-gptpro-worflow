import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { validatePrivateDirectory } from './acp-client.mjs'
import { FORCED_GROK_ENV } from './exact-env.mjs'

const POLICY_FILE = 'ccg-grok-runtime-policy.json'

export function lockDownWindowsDirectory(path) {
  const shell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$targetPath = [Console]::In.ReadToEnd()',
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sid = $identity.User',
    '$acl = Get-Acl -LiteralPath $targetPath',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$acl.SetOwner($sid)',
    '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")',
    '$acl.SetAccessRule($rule)',
    'Set-Acl -LiteralPath $targetPath -AclObject $acl',
  ].join('; ')
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    input: path,
    windowsHide: true,
    env: Object.fromEntries(Object.entries({
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec,
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
    }).filter(([, value]) => typeof value === 'string' && value.length > 0)),
  })
  if (result.status !== 0)
    throw new Error(`Unable to create owner-only Windows ACL: ${String(result.stderr).trim()}`)
}

export async function securePrivateDirectory(path, {
  platform = process.platform,
  restrictWindowsAcl = lockDownWindowsDirectory,
  validateDirectory = validatePrivateDirectory,
} = {}) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  if (platform === 'win32')
    await restrictWindowsAcl(path)
  return validateDirectory(path, { platform })
}

async function assertNoReparseTree(path) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink())
    throw new Error(`Private cleanup refuses a symbolic link, junction, or reparse point: ${path}`)
  if (!metadata.isDirectory())
    return
  for (const entry of await readdir(path))
    await assertNoReparseTree(resolve(path, entry))
}

async function createPrivateDirectory(path, { platform, restrictWindowsAcl, validateDirectory }) {
  return securePrivateDirectory(path, { platform, restrictWindowsAcl, validateDirectory })
}

export async function removePrivateRunRoot(runRoot, { allowedParent } = {}) {
  if (!isAbsolute(runRoot) || !isAbsolute(allowedParent))
    throw new Error('Private cleanup requires absolute run and parent paths')
  const canonicalParent = await realpath(allowedParent)
  const canonicalRunRoot = await realpath(runRoot)
  const rel = relative(canonicalParent, canonicalRunRoot)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/^ccg-grok-run-[^\\/]+$/i.test(rel))
    throw new Error('Private cleanup target is outside its intended parent')
  await assertNoReparseTree(runRoot)
  await rm(canonicalRunRoot, { recursive: true, force: true })
}

export async function createPrivateRunRoots({
  parent,
  grokHome,
  platform = process.platform,
  restrictWindowsAcl = lockDownWindowsDirectory,
  validateDirectory = validatePrivateDirectory,
} = {}) {
  if (!isAbsolute(parent) || !isAbsolute(grokHome))
    throw new Error('Private temp parent and GROK_HOME must be absolute paths')
  const canonicalParent = await validateDirectory(parent, { platform })
  await validateDirectory(grokHome, { platform })
  const runRoot = await mkdtemp(resolve(canonicalParent, 'ccg-grok-run-'))
  try {
    await chmod(runRoot, 0o700)
    if (platform === 'win32')
      await restrictWindowsAcl(runRoot)
    await validateDirectory(runRoot, { platform })
    const neutralHome = resolve(runRoot, 'neutral-home')
    const snapshotRoot = resolve(runRoot, 'snapshot')
    const rawEventsDir = resolve(runRoot, 'raw')
    for (const path of [neutralHome, snapshotRoot, rawEventsDir])
      await createPrivateDirectory(path, { platform, restrictWindowsAcl, validateDirectory })

    const policy = {
      schemaVersion: 1,
      filesystemTools: false,
      terminalTools: false,
      webFetch: false,
      toolSearch: false,
      subagents: false,
      memory: false,
      autoUpdate: false,
      compatibility: { claude: false, cursor: false, codex: false },
      forcedEnvironment: FORCED_GROK_ENV,
    }
    const policyPath = resolve(neutralHome, POLICY_FILE)
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(policyPath, 0o400)
    const verified = JSON.parse(await readFile(policyPath, 'utf8'))
    if (Object.entries(FORCED_GROK_ENV).some(([name, value]) => verified.forcedEnvironment?.[name] !== value))
      throw new Error('Private Grok runtime policy did not preserve every forced disabled setting')

    return {
      runRoot: await realpath(runRoot),
      neutralHome: await realpath(neutralHome),
      snapshotRoot: await realpath(snapshotRoot),
      rawEventsDir: await realpath(rawEventsDir),
      grokHome: await realpath(grokHome),
      policyPath,
      cleanup: () => removePrivateRunRoot(runRoot, { allowedParent: canonicalParent }),
    }
  }
  catch (error) {
    await removePrivateRunRoot(runRoot, { allowedParent: canonicalParent }).catch(() => {})
    throw error
  }
}
