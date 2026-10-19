import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ElectronManifest {
  dependencies?: Record<string, string>
  dshElectron?: { runtimePlugins?: string[]; ecosystemPlugins?: string[] }
  build: {
    extraMetadata: { name: string }
    files: string[]
    extraResources: Array<{ from: string; to: string }>
    nsis: { useZip: boolean; differentialPackage: boolean; include: string; script?: string }
    win: { extraResources?: Array<{ from: string; to: string }> }
  }
}

describe('Electron packaging', () => {
  it('uses checked Windows extraction and an unscoped packaged identity', async () => {
    const manifestPath = join(import.meta.dirname, '..', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ElectronManifest

    expect(manifest.build.nsis.useZip).toBe(true)
    expect(manifest.build.nsis.differentialPackage).toBe(false)
    expect(manifest.build.nsis.include).toBe('.electron-build/nsis/include.nsh')
    expect(manifest.build.nsis.script).toBeUndefined()
    expect(manifest.build.extraMetadata.name).toBe('rivetdeck')
    expect(manifest.build.files).toContain('build-info.json')
  })

  it('keeps managed distributions out of installers and ships only the Windows Core executor', async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as ElectronManifest
    expect(manifest.build.extraResources.some(resource => resource.to.startsWith('toolchains'))).toBe(false)
    expect(manifest.build.win.extraResources).toEqual([{ from: '.electron-build/core-runtime/current', to: 'core-runtime' }])
  })

  it('ships the prepared Network Runtime from an application-owned resource path', async () => {
    const manifestPath = join(import.meta.dirname, '..', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ElectronManifest

    expect(manifest.build.extraResources).toContainEqual({
      from: '.electron-build/network-runtime/current',
      to: 'network-runtime',
    })
  })

  it('installs every declared bundled plugin as an exact production registry dependency', async () => {
    const electronRoot = join(import.meta.dirname, '..')
    const manifest = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8')) as ElectronManifest
    const names = [
      ...(manifest.dshElectron?.runtimePlugins ?? []),
      ...(manifest.dshElectron?.ecosystemPlugins ?? []),
    ]
    for (const name of names) {
      expect(manifest.dependencies?.[name]).toBeDefined()
      expect(manifest.dependencies?.[name]).not.toMatch(/^workspace:/)
      expect(existsSync(join(electronRoot, 'node_modules', ...name.split('/'), 'package.json'))).toBe(true)
    }
    expect(manifest.dependencies?.['@dsh-electron/dsh-plugin-git']).toBe('0.2.7')
    expect(manifest.dependencies?.['@dsh-electron/dsh-theme-studio']).toBe('0.1.5')
  })
})

it('generates checked Windows ZIP extraction while retaining default NSIS compilation', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { default: prepare, prepareWindowsInstallerScript } = await import('../scripts/prepare-windows-installer.mjs')
  const projectDir = await mkdtemp(join(tmpdir(), 'dsh-nsis-'))
  try {
    await prepare({ electronPlatformName: 'darwin', packager: { projectDir } })
    expect(existsSync(join(projectDir, '.electron-build/nsis'))).toBe(false)
    const sevenZip = String.raw`C:\Program Files\7-Zip\7za.exe`
    await prepareWindowsInstallerScript(projectDir, sevenZip)
    const extraction = await readFile(join(projectDir, '.electron-build/nsis/extractAppPackage.nsh'), 'utf8')
    expect(extraction).toContain(`File /oname=$PLUGINSDIR\\dsh-7za.exe "${sevenZip}"`)
    expect(extraction).toContain('nsExec::ExecToLog')
    expect(extraction).toContain('-aoa -y')
    expect(extraction).toContain('StrCmp $R0 "0" +4')
    expect(extraction).toContain('$(decompressionFailed)')
    expect(extraction).toContain('SetErrorLevel 1')
    expect(extraction).not.toContain('nsisunz::Unzip')
    const include = await readFile(join(projectDir, '.electron-build/nsis/include.nsh'), 'utf8')
    expect(include).toContain('!cd')
    expect(include).toContain(`!include "${join(projectDir, '.electron-build/nsis/uninstall-strings.nsh')}"`)
    expect(include).toContain(`!include "${join(projectDir, '.electron-build/nsis/uninstall.nsh')}"`)
    const section = await readFile(join(projectDir, '.electron-build/nsis/installSection.nsh'), 'utf8')
    expect(section).toContain(`!include "${join(projectDir, '.electron-build/nsis/installer.nsh')}"`)
    const installer = await readFile(join(projectDir, '.electron-build/nsis/installer.nsh'), 'utf8')
    expect(installer).toContain(`!include "${join(projectDir, '.electron-build/nsis/extractAppPackage.nsh')}"`)
    expect(existsSync(join(projectDir, '.electron-build/nsis/installer.nsi'))).toBe(false)
    const uninstaller = await readFile(join(projectDir, '.electron-build/nsis/uninstaller.nsh'), 'utf8')
    expect(uninstaller).toContain('Function un.onInit')
    expect(uninstaller).toContain('Section "un.${UNINSTALL_SECTION_NAME}"')
    // The stock --delete-app-data bypass must be gone; install-dir removal keeps
    // the extended-length prefix so deep installation directories still clean.
    expect(uninstaller).not.toContain('isDeleteAppData')
    expect(uninstaller).not.toContain('RMDir /r "$APPDATA')
    expect(uninstaller).toContain('RMDir /r "\\\\?\\$INSTDIR"')
  } finally { await rm(projectDir, { recursive: true, force: true }) }
})

it('wires the layered data-cleanup uninstaller through the native helper', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { prepareWindowsInstallerScript } = await import('../scripts/prepare-windows-installer.mjs')
  const electronRoot = join(import.meta.dirname, '..')
  const projectDir = await mkdtemp(join(tmpdir(), 'dsh-nsis-'))
  try {
    await prepareWindowsInstallerScript(projectDir, 'C:\\tools\\7za.exe',
      { helperDll: 'C:\\build\\rivetdeck-uninstall.dll', updaterCacheName: 'rivetdeck-updater' })
    const output = join(projectDir, '.electron-build/nsis')
    const nsh = await readFile(join(output, 'uninstall.nsh'), 'utf8')

    // Replacement and update flows keep data; the record beside the default userData is
    // outside $INSTDIR, so it already survives for the succeeding install.
    // Options are parsed with FileFunc, not the StdUtils-backed flag macros: the custom
    // functions compile before the plugin directory registers StdUtils.
    expect(nsh).toContain('${GetOptions} $R0 "--updated"')
    expect(nsh).toContain('/KEEP_APP_DATA')
    expect(nsh).not.toContain('$INSTDIR\\${RIVETDECK_PATH_HISTORY}')
    expect(nsh).not.toContain('CopyFiles')
    expect(nsh).toContain('${AndIfNot} ${FileExists} "$APPDATA\\${RIVETDECK_PATH_HISTORY}"')
    expect(nsh).toContain('FileWrite $0 "complete=1$\\r$\\n"')
    // Fresh installs seed the record beside userData so the app can always rewrite it;
    // a surviving record is never overwritten. The install flags cannot detect a fresh
    // install — /currentuser forces $hasPerUserInstallation to 1.
    expect(nsh).toContain('FileOpen $0 "$APPDATA\\${RIVETDECK_PATH_HISTORY}" w')
    expect(nsh).not.toContain('$hasPerUserInstallation')
    const installMacro = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macro customUnInstall'))
    // Unregistered legacy installs can still leave data containing an unrecorded home.
    expect(installMacro).toContain('${If} $installationDir == ""')
    expect(installMacro).toContain('${AndIfNot} ${FileExists} "$APPDATA\\${APP_FILENAME}"')
    expect(installMacro).toContain('FileWrite $0 "complete=0$\\r$\\n"')
    // Electron data is always per-user: under an all-users install the section runs in
    // the "all" shell context where $APPDATA is ProgramData, so the seed brackets its
    // write with the same context switch the uninstall side uses.
    expect(installMacro).toContain('SetShellVarContext current')
    expect(installMacro).toContain('SetShellVarContext all')

    // History, env protection, tiered targets, and the updater cache reach the helper.
    expect(nsh).toContain('ReadEnvStr $UnHome DSH_HOME')
    expect(nsh).toContain('StrCpy $UnTarget "$APPDATA\\${APP_FILENAME}"')
    expect(nsh).toContain('StrCpy $UnHistory "$APPDATA\\${RIVETDECK_PATH_HISTORY}"')
    expect(nsh).toContain('$LOCALAPPDATA\\${RIVETDECK_UPDATER_CACHE}')
    expect(nsh).toContain('!define RIVETDECK_UPDATER_CACHE "rivetdeck-updater"')
    expect(nsh).toContain('File "/oname=$PLUGINSDIR\\rivetdeck-uninstall.dll" "${RIVETDECK_UNINSTALL_HELPER}"')
    expect(nsh).toContain('UninstallCleanup(w "$UnTarget", w "$INSTDIR", w "$UnHome", w "$UnHistory"')
    expect(nsh).toContain('${GetOptions} $R0 "--delete-app-data"')
    expect(nsh).toContain('DetailPrint "$(RIVETDECK_UNINSTALL_RESIDUE)"')
    expect(nsh).toContain('*i .R7, *i .R9) i .R8 ?cr')
    expect(nsh).toContain('Pop $R5')
    expect(nsh).toContain('${If} $R5 != "ok"')
    expect(nsh).toContain('${If} $R8 != 0')
    expect(nsh).toContain('${OrIf} $R9 != 0')
    expect(nsh).toContain('${If} $R7 > 0\n  ${AndIf} $R9 == 0')
    for (const key of ['HELPER_ERROR', 'ERROR', 'REPORT_ERROR', 'SKIPPED']) {
      expect(nsh).toContain(`$(RIVETDECK_UNINSTALL_${key})`)
    }
    expect(nsh).toContain('SetDetailsView show')
    expect(nsh).toContain('MessageBox MB_OK|MB_ICONEXCLAMATION')
    expect(nsh).toContain('!macro customUnInstall')
    expect(nsh).toContain('!macro customInstall')
    expect(nsh).toContain('Call un.RivetdeckCleanData')
    expect(nsh).not.toContain('RMDir')

    // The custom include is parsed before the stock script loads LogicLib/FileFunc, so the
    // file provides them itself; function bodies must not touch variables multiUser.nsh
    // only declares later (the shell-context switch lives in the expanding macro instead).
    expect(nsh.indexOf('!include "LogicLib.nsh"')).toBeLessThan(nsh.indexOf('Function un.'))
    expect(nsh.indexOf('!include "FileFunc.nsh"')).toBeLessThan(nsh.indexOf('Function un.'))
    const functions = nsh.slice(nsh.indexOf('Function un.'))
    expect(functions).not.toContain('$installMode')

    // Localized residue text is generated from the owned dictionary, not hardcoded.
    const strings = await readFile(join(output, 'uninstall-strings.nsh'), 'utf8')
    expect(strings).toContain('LangString RIVETDECK_UNINSTALL_RESIDUE 1033 ')
    expect(strings).toContain('LangString RIVETDECK_UNINSTALL_RESIDUE 2052 ')
    for (const language of [1033, 2052]) {
      for (const key of ['HELPER_ERROR', 'ERROR', 'REPORT_ERROR', 'SKIPPED']) {
        expect(strings).toContain(`LangString RIVETDECK_UNINSTALL_${key} ${language} `)
      }
    }
    const messages = await readFile(join(electronRoot, 'installer/uninstall-messages.yml'), 'utf8')
    expect(messages).toContain('RIVETDECK_UNINSTALL_RESIDUE')
    expect(messages).toContain('zh:')

    // The native helper and its orchestration exist and export the System::Call entry.
    const helper = await readFile(join(electronRoot, 'installer/uninstall-data.cpp'), 'utf8')
    expect(helper).toContain('UninstallCleanup')
    expect(helper).toContain('__cdecl')
    const orchestration = await readFile(join(electronRoot, 'installer/uninstall-cleanup.h'), 'utf8')
    for (const claim of ['managed-toolchains', 'active.json', 'Partitions', 'GPUCache',
      'L"userData"', 'L"dshHome"', 'L"complete"', 'installation.pending']) {
      expect(orchestration).toContain(claim)
    }
    for (const required of ['LoadHistory', 'VerifyManagedToolchains', 'VerifyShimDirectory',
      'VerifyUpdaterCache', 'IsAttributedUserData', 'unresolvableProtection',
      'desktop-preferences.json', 'network-secrets']) {
      expect(orchestration).toContain(required)
    }
    const primitives = await readFile(join(electronRoot, 'installer/uninstall-data.h'), 'utf8')
    for (const required of ['FILE_FLAG_OPEN_REPARSE_POINT', 'Pin', 'RemoveTree',
      'RemoveEmptyParents', 'Contains']) {
      expect(primitives).toContain(required)
    }
    expect(existsSync(join(electronRoot, 'tests/windows-uninstall-data.cpp'))).toBe(true)
    expect(existsSync(join(electronRoot, 'scripts/prepare-windows-uninstall-helper.ps1'))).toBe(true)

    // The launch-time recorder writes the same file the uninstaller reads.
    const main = await readFile(join(electronRoot, 'src/main.ts'), 'utf8')
    expect(main).toContain('mergeLaunchPathHistory')
    const recorder = await readFile(join(electronRoot, 'src/path-history.ts'), 'utf8')
    expect(recorder).toContain("PATH_HISTORY_FILE = 'rivetdeck-path-history.ini'")
  } finally { await rm(projectDir, { recursive: true, force: true }) }
})

it('escapes NSIS metacharacters in generated LangStrings', async () => {
  const { renderNsisStrings } = await import('../scripts/prepare-windows-installer.mjs')
  // A literal $ doubles; quotes and line breaks use $\-escapes so the dictionary text
  // cannot break out of its LangString or feed variables to the compiler.
  const strings = renderNsisStrings({ MSG: { en: 'costs $5 "now"\r\nnext' } })
  expect(strings).toContain('LangString MSG 1033 "costs $$5 $\\"now$\\"$\\r$\\nnext"')
})
