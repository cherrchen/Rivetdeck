import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aboutCommitUrl, aboutDocument, normalizeAboutExternalUrl, resolveAboutRevision } from '../src/about.ts'
import { resolveHomepageUrl, resolveProjectUrl } from '../src/desktop/index.ts'
import { en } from '../src/locale.ts'
import { buildInfoDocument, writeBuildInfo } from '../scripts/write-build-info.mjs'

describe('desktop About document', () => {
  it('renders Version/Build/Commit rows with GitHub before Homepage actions', () => {
    const document = decodeURIComponent(aboutDocument({
      applicationName: 'Rivetdeck',
      build: undefined,
      commit: '332b2aefc',
      commitUrl: 'https://github.com/example/rivetdeck/commit/332b2aefc',
      iconDataUrl: 'data:image/png;base64,aa',
      localeId: 'en',
      messages: en,
      projectUrl: 'https://github.com/example/rivetdeck',
      version: '1.2.3',
      websiteUrl: 'https://rivetdeck.hometown123.top',
    }).replace(/^data:text\/html;charset=utf-8,/, ''))

    expect(document).toContain(`<dt>${en.aboutVersionLabel}</dt><dd>1.2.3</dd>`)
    expect(document).toContain(`<dt>${en.aboutBuildLabel}</dt><dd></dd>`)
    expect(document).toContain('332b2aefc')
    expect(document).toContain(en.aboutBody)
    const github = document.indexOf(`>${en.aboutGitHub}</a>`)
    const homepage = document.indexOf(`>${en.aboutHomepage}</a>`)
    expect(github).toBeGreaterThan(-1)
    expect(homepage).toBeGreaterThan(github)
    expect(document).toContain('https://github.com/example/rivetdeck')
    expect(document).toContain('https://rivetdeck.hometown123.top')
  })

  it('treats trailing-slash homepage URLs as the same external target', () => {
    expect(normalizeAboutExternalUrl('https://rivetdeck.hometown123.top/'))
      .toBe('https://rivetdeck.hometown123.top')
    expect(normalizeAboutExternalUrl('https://rivetdeck.hometown123.top'))
      .toBe('https://rivetdeck.hometown123.top')
  })

  it('prefers packaged build-info.json over the environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rivetdeck-about-'))
    try {
      await writeFile(join(directory, 'build-info.json'), `${JSON.stringify({ build: '42', commit: 'abcdef012' }, null, 2)}\n`)
      expect(resolveAboutRevision(directory, { RIVETDECK_BUILD: '9', RIVETDECK_COMMIT: 'zzzzzzzzz' }))
        .toEqual({ build: '42', commit: 'abcdef012' })
      expect(resolveAboutRevision(undefined, { RIVETDECK_BUILD: ' 15212 ', RIVETDECK_COMMIT: 'abc1234' }))
        .toEqual({ build: '15212', commit: 'abc1234' })
      expect(aboutCommitUrl('https://github.com/example/rivetdeck', 'abc1234'))
        .toBe('https://github.com/example/rivetdeck/commit/abc1234')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes release About identity from the desktop-release run number', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rivetdeck-build-info-'))
    const path = join(directory, 'build-info.json')
    try {
      expect(buildInfoDocument({
        RIVETDECK_BUILD: '17',
        GITHUB_SHA: '332b2aefc1234567890',
      })).toEqual({ build: '17', commit: '332b2aefc' })
      writeBuildInfo({ RIVETDECK_BUILD: '17', RIVETDECK_COMMIT: '332b2aefc1234567890' }, path)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ build: '17', commit: '332b2aefc' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps repository and homepage URLs distinct', () => {
    expect(resolveProjectUrl({
      repository: { type: 'git', url: 'https://github.com/example/rivetdeck.git' },
      homepage: 'https://rivetdeck.hometown123.top',
    })).toBe('https://github.com/example/rivetdeck')
    expect(resolveHomepageUrl({
      repository: { type: 'git', url: 'https://github.com/example/rivetdeck.git' },
      homepage: 'https://rivetdeck.hometown123.top/',
    })).toBe('https://rivetdeck.hometown123.top')
  })
})
