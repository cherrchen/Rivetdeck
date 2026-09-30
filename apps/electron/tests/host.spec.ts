import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHostArguments } from '../src/host.ts'

describe('Desktop Host argv', () => {
  it('parses application path, overlay, and web-app arguments', () => {
    expect(parseHostArguments(['/app', '/data/overlay.yml', '--', '--port', '0', '--no-open'])).toEqual({
      appPath: resolve('/app'),
      patchPath: resolve('/data/overlay.yml'),
      args: ['--port', '0', '--no-open'],
    })
  })

  it('defaults web-app arguments when none are supplied', () => {
    expect(parseHostArguments(['/app', '/data/overlay.yml']).args).toEqual(['--port', '0', '--no-open'])
  })

  it('fails loud when required paths are missing', () => {
    expect(() => parseHostArguments(['/app'])).toThrow(/expected <appPath> <patchPath>/)
  })
})
