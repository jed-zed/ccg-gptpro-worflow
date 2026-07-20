import { describe, expect, it } from 'vitest'
import { execSafe } from '../../commands/doctor'

describe('doctor command helpers', () => {
  it('executes child commands from the ESM CLI', () => {
    expect(execSafe(`"${process.execPath}" --version`)).toBe(process.version)
  })
})
