import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('Desktop synchronization and release workflows', () => {
  it('assigns upstream and downstream workflow paths to their repository owners', () => {
    const attributes = readFileSync(resolve(root, '.gitattributes'), 'utf8')

    expect(attributes).toContain('docs/electron/** merge=ours')
    expect(attributes).not.toContain('packages/dsh-electron')
    expect(attributes).toContain('.github/workflows/*.yml merge=theirs')
    expect(attributes).toContain('.github/workflows/desktop-*.yml merge=ours')
    expect(attributes).toContain('.github/workflows/sync-upstream.yml merge=ours')
    expect(attributes).toContain('scripts/ci-workflow.spec.ts merge=theirs')
    expect(attributes).toContain('scripts/desktop-workflow.spec.ts merge=ours')
  })

  it('keeps routine desktop CI lightweight and packages releases on native x64 and ARM64 runners', () => {
    const ci = loadWorkflow('.github/workflows/desktop-ci.yml')
    const release = loadWorkflow('.github/workflows/desktop-release.yml')
    const electronManifest: unknown = JSON.parse(readFileSync(resolve(root, 'apps/electron/package.json'), 'utf8'))
    if (!isRecord(ci.jobs) || !isRecord(release.jobs)) {
      throw new TypeError('Desktop workflows must define jobs')
    }
    if (!isRecord(electronManifest) || !isRecord(electronManifest.build)) {
      throw new TypeError('Electron manifest must define build configuration')
    }

    expect(ci.on).toMatchObject({
      push: { branches: ['develop', 'main'] },
      pull_request: { branches: ['develop', 'main'] },
    })
    expect(ci.jobs).not.toHaveProperty('package')
    const ciSteps = Object.values(ci.jobs).flatMap(job => (
      isRecord(job) && Array.isArray(job.steps) ? job.steps.filter(isRecord) : []
    ))
    expect(ciSteps.find(step => step.name === 'Build installer')).toBeUndefined()
    expect(ciSteps.filter(step => step.name === 'Type-check Electron application')).toHaveLength(2)
    expect(ciSteps.filter(step => step.name === 'Lint Electron application')).toHaveLength(2)

    // The supervised Host's stdio wiring is Windows-only: the Linux job never opens
    // the null device, so a Windows runner is the only place the spawn path is real.
    const windowsJob = workflowJob(ci, 'windows-host-startup')
    expect(windowsJob).toMatchObject({ 'runs-on': 'windows-latest' })
    if (!Array.isArray(windowsJob.steps)) {
      throw new TypeError('Desktop CI must define the Windows Host startup steps')
    }
    const windowsTest = windowsJob.steps.filter(isRecord).find(step => step.name === 'Test supervised Host startup')
    expect(windowsTest?.run).toBe('pnpm exec vitest run apps/electron/tests/runtime.spec.ts')
    expect(windowsJob.steps.filter(isRecord).map(step => step.name)).not.toContain('Build upstream application')

    const packageJob = workflowJob(release, 'package')
    if (!isRecord(packageJob.strategy) || !isRecord(packageJob.strategy.matrix) || !Array.isArray(packageJob.strategy.matrix.include)) {
      throw new TypeError('Desktop release package job must define an include matrix')
    }
    expect(packageJob.strategy.matrix.include).toEqual([
      expect.objectContaining({
        name: 'Windows x64',
        runner: 'windows-latest',
        args: '--win nsis --x64 --config.nsis.oneClick=false --config.nsis.allowToChangeInstallationDirectory=true',
        artifact: 'windows-x64',
      }),
      expect.objectContaining({
        name: 'Windows ARM64',
        runner: 'windows-11-arm',
        args: '--win nsis --arm64 --config.nsis.oneClick=false --config.nsis.allowToChangeInstallationDirectory=true',
        artifact: 'windows-arm64',
      }),
      expect.objectContaining({ name: 'macOS x64', runner: 'macos-15-intel', args: '--mac dmg zip --x64', artifact: 'macos-x64' }),
      expect.objectContaining({ name: 'macOS ARM64', runner: 'macos-15', args: '--mac dmg zip --arm64', artifact: 'macos-arm64' }),
      expect.objectContaining({
        name: 'Linux x64',
        runner: 'ubuntu-latest',
        args: '--linux AppImage deb --x64',
        artifact: 'linux-x64',
        files: 'dist/electron/*.AppImage\ndist/electron/*.deb\ndist/electron/latest-linux*.yml\n',
      }),
      expect.objectContaining({
        name: 'Linux ARM64',
        runner: 'ubuntu-24.04-arm',
        args: '--linux AppImage deb --arm64',
        artifact: 'linux-arm64',
        files: 'dist/electron/*.AppImage\ndist/electron/*.deb\ndist/electron/latest-linux*.yml\n',
      }),
    ])
    expect(electronManifest.build.nsis).toEqual({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      useZip: true,
      include: '.electron-build/nsis/include.nsh',
      differentialPackage: false,
    })
  })

  it('merges upstream into develop and publishes Beta tags from the sync workflow', () => {
    const sync = loadWorkflow('.github/workflows/sync-upstream.yml')
    expect(sync.env).toMatchObject({ GH_REPO: '${{ github.repository }}' })
    const syncJob = workflowJob(sync, 'sync')
    expect(sync.on).not.toHaveProperty('schedule')
    expect(syncJob.if).toBe("github.event_name == 'workflow_dispatch' && inputs.allow_master_sync")
    if (!Array.isArray(syncJob.steps)) {
      throw new TypeError('Desktop sync must define steps')
    }

    const steps = syncJob.steps.filter(isRecord)
    const checkout = steps.find(step => step.uses === 'actions/checkout@v6')
    const merge = steps.find(step => step.name === 'Merge upstream with downstream conflict policy')
    const prepareBeta = steps.find(step => step.name === 'Prepare Beta release commit')
    const push = steps.find(step => step.name === 'Push verified Beta commit to develop')
    const waitForCi = steps.find(step => step.name === 'Wait for Desktop CI')
    const beta = steps.find(step => step.name === 'Publish Beta tag')
    if (typeof merge?.run !== 'string'
      || typeof prepareBeta?.run !== 'string'
      || typeof push?.run !== 'string'
      || typeof waitForCi?.run !== 'string'
      || typeof beta?.run !== 'string') {
      throw new TypeError('Desktop sync must prepare and push Beta commits, await CI, and publish Beta tags')
    }

    expect(sync.permissions).toMatchObject({ actions: 'read', checks: 'read', contents: 'write' })
    expect(checkout).toMatchObject({ with: { ref: 'develop' } })
    expect(merge.run).toContain('git merge --no-edit upstream/master')
    expect(merge.run).toContain("git config merge.theirs.driver 'cp %B %A'")
    expect(merge.run).toContain('README.md|README.zh.md|README.i18n.yaml|docs/electron/*')
    expect(merge.run).toContain('.github/workflows/desktop-*.yml|.github/workflows/sync-upstream.yml|scripts/desktop-workflow.spec.ts')
    expect(merge.run).toContain('AGENTS.md|.github/workflows/*.yml|scripts/ci-workflow.spec.ts')
    expect(merge.run).toContain('git checkout --theirs -- "$file"')
    expect(merge.run).toContain('AGENTS.md')
    expect(merge.run).toContain('pnpm-lock.yaml|pnpm-workspace.yaml')
    expect(merge.run).toContain('restore-agents-downstream.mjs')
    expect(merge.run).toContain('sync-version.mjs')
    expect(merge.run).toContain('pnpm install --no-frozen-lockfile')
    expect(merge.run).not.toMatch(/pnpm install --lockfile-only/)
    expect(merge.run).toContain('apps/electron')
    expect(prepareBeta.run).toContain('next-beta-tag.mjs')
    expect(prepareBeta.run).toContain('set-version.mjs')
    expect(prepareBeta.run).toContain('pnpm install --no-frozen-lockfile')
    expect(prepareBeta.run).toContain('release(electron)')
    expect(push.run).toContain('git push origin HEAD:develop')
    expect(push.run).not.toContain('HEAD:main')
    expect(push.run).toContain('sha=$after')
    expect(waitForCi.run).toContain('actions/workflows/desktop-ci.yml/runs?event=push&branch=develop')
    expect(waitForCi.run).toContain('select(.head_sha == $sha)')
    expect(waitForCi.run).toContain('gh run watch "$run_id" --repo "$GH_REPO" --exit-status')
    expect(waitForCi.run).not.toContain('gh workflow run')
    expect(beta.run).toContain('git tag -a "$BETA_TAG"')
    expect(beta.run).toContain('git push origin "refs/tags/$BETA_TAG"')
    expect(beta.run).not.toContain('git push origin HEAD:develop')
    expect(steps.indexOf(prepareBeta)).toBeLessThan(steps.indexOf(push))
    expect(steps.indexOf(push)).toBeLessThan(steps.indexOf(waitForCi))
    expect(steps.indexOf(waitForCi)).toBeLessThan(steps.indexOf(beta))
    expect(steps.filter(step => typeof step.run === 'string' && step.run.includes('git push origin HEAD:develop'))).toHaveLength(1)
  })

  it('requires promotion PRs to prepare the desktop version before main is tagged', () => {
    const ci = loadWorkflow('.github/workflows/desktop-ci.yml')
    const promote = loadWorkflow('.github/workflows/desktop-promote.yml')
    const validateJob = workflowJob(ci, 'validate')
    const promoteJob = workflowJob(promote, 'promote')
    if (!Array.isArray(validateJob.steps) || !Array.isArray(promoteJob.steps)) {
      throw new TypeError('Desktop CI and promote must define steps')
    }
    const prepare = validateJob.steps.filter(isRecord).find(step => step.name === 'Verify prepared desktop promotion')
    const release = promoteJob.steps.filter(isRecord).find(step => step.name === 'Validate prepared version and publish tag')
    const checkout = promoteJob.steps.filter(isRecord).find(step => step.uses === 'actions/checkout@v6')
    if (typeof prepare?.run !== 'string' || typeof release?.run !== 'string') {
      throw new TypeError('Desktop CI must verify prepared versions and promote must publish their tags')
    }

    expect(prepare.if).toBe("github.event_name == 'pull_request' && github.base_ref == 'main'")
    expect(prepare.env).toMatchObject({ HEAD_REF: '${{ github.head_ref }}' })
    expect(prepare.run).toContain('[ "$HEAD_REF" != "develop" ]')
    expect(prepare.run).toContain('pnpm electron:set-version $cli_version')
    expect(promote.on).toMatchObject({
      push: {
        branches: ['main'],
        paths: ['apps/electron/package.json'],
      },
    })
    expect(checkout).toMatchObject({ with: { ref: 'main', 'fetch-depth': 0 } })
    expect(release.run).toContain("require('./apps/cli/package.json').version")
    expect(release.run).toContain("require('./apps/electron/package.json').version")
    expect(release.run).toContain('release_tag="v${electron_version}"')
    expect(release.run).toContain('git push origin "refs/tags/${release_tag}"')
    expect(release.run).not.toContain('set-version.mjs')
    expect(release.run).not.toContain('pnpm install')
    expect(release.run).not.toContain('git commit')
    expect(release.run).not.toContain('HEAD:main')
  })

  it('validates release tags against the correct branch before packaging installers', () => {
    const release = loadWorkflow('.github/workflows/desktop-release.yml')
    const validate = workflowJob(release, 'validate')
    const publish = workflowJob(release, 'publish')
    if (!Array.isArray(validate.steps) || !Array.isArray(publish.steps)) {
      throw new TypeError('Desktop release must validate tags and publish installers')
    }
    const context = validate.steps.filter(isRecord).find(step => step.name === 'Resolve release context')
    const checkout = validate.steps.filter(isRecord).find(step => step.uses === 'actions/checkout@v6')
    const notes = publish.steps.filter(isRecord).find(step => step.name === 'Write checksums and release notes')
    const create = publish.steps.filter(isRecord).find(step => step.name === 'Create release and upload installers')
    if (typeof context?.run !== 'string' || typeof create?.run !== 'string') {
      throw new TypeError('Desktop release must resolve context and create a release')
    }

    expect(release.on).toMatchObject({
      push: {
        tags: [
          'v[0-9]+.[0-9]+.[0-9]+-beta.[0-9]+',
          'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+',
          'v[0-9]+.[0-9]+.[0-9]+',
        ],
      },
    })
    expect(context.run).toContain('expected_branch=develop')
    expect(context.run).toContain('expected_branch=main')
    expect(checkout).toMatchObject({
      with: {
        ref: '${{ github.event.inputs.tag || github.ref_name }}',
        'fetch-depth': 0,
      },
    })
    expect(context.run).toContain('version="${tag#v}"')
    expect(context.run).toContain('Requested version ${{ inputs.version }} does not match tag version $version.')
    expect(context.run).toContain('Requested prerelease value ${{ inputs.prerelease }} does not match tag $tag.')
    expect(context.run).toContain('git merge-base --is-ancestor HEAD "origin/$expected_branch"')
    expect(context.run).toContain("require('./apps/electron/package.json').version")
    expect(notes?.run).not.toContain('deepseek-ai/deepseek-harness/commit')
    expect(create.run).toContain('gh release view "$RELEASE_TAG"')
  })

  it('launches the installed Windows application before uninstalling on both architectures', () => {
    const release = loadWorkflow('.github/workflows/desktop-release.yml')
    const packageJob = workflowJob(release, 'package')
    if (!Array.isArray(packageJob.steps)) throw new TypeError('Desktop release must define packaging steps')
    const smoke = packageJob.steps.filter(isRecord).find(step => step.name === 'Smoke-test Windows installer')
    expect(smoke?.run).toContain("-Architecture '${{ matrix.arch }}'")
    const installerSmoke = readFileSync(resolve(root, 'apps/electron/scripts/smoke-windows-installer.ps1'), 'utf8')
    const startup = installerSmoke.indexOf("& node (Join-Path $PSScriptRoot 'smoke-runtime-setup.mjs') $application --offline --startup-only")
    expect(startup).toBeGreaterThan(-1)
    expect(installerSmoke.slice(startup)).toContain('if ($LASTEXITCODE -ne 0)')
    expect(installerSmoke.slice(startup)).toContain('} finally {')
    expect(installerSmoke.indexOf('$uninstall = Start-Process')).toBeGreaterThan(startup)
    expect(packageJob.steps.filter(isRecord).map(step => step.run).join('\n')).not.toContain('dist/electron/win-unpacked')
  })
  it('runs the deep-path NSIS installation smoke on Windows pull requests', () => {
    const ci = loadWorkflow('.github/workflows/desktop-ci.yml')
    const lifecycle = workflowJob(ci, 'managed-runtime-lifecycle')
    if (!Array.isArray(lifecycle.steps)) throw new TypeError('Runtime lifecycle must define steps')
    const smoke = lifecycle.steps.filter(isRecord).find(step => step.name === 'Verify Windows deep-path installer lifecycle')
    expect(smoke?.if).toBe("runner.os == 'Windows'")
    expect(smoke?.run).toContain('--prepackaged ../../dist/electron/win-unpacked')
    expect(smoke?.run).toContain("if ($LASTEXITCODE -ne 0) { throw 'Windows NSIS build failed.' }")
    if (typeof smoke?.run !== 'string') throw new TypeError('Windows installer smoke must define commands')
    expect(smoke.run.indexOf('if ($LASTEXITCODE -ne 0)')).toBeLessThan(smoke.run.indexOf('$installer ='))
    expect(smoke.run).toContain('smoke-windows-installer.ps1')
  })

})


function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
