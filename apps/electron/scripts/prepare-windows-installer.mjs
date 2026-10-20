/** Build the maintained NSIS templates with checked, long-path-capable ZIP extraction,
 * plus the Rivetdeck data-cleanup uninstaller: the stock electron-builder RMDir /r app-data
 * bypass is stripped and every deletion outside $INSTDIR goes through the native helper. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const templates = join(dirname(libraryRequire.resolve('app-builder-lib/package.json')), 'templates/nsis')
const { getPath7za } = libraryRequire('app-builder-lib/out/toolsets/7zip.js')
const { bundledLanguages, lcid, toLangWithRegion } = libraryRequire('app-builder-lib/out/util/langs.js')
const yaml = require('js-yaml')
// NSIS splits include paths on the native separator; Windows includes require backslashes.
const quoted = path => path.replaceAll('$', '$$')
const installerResources = join(dirname(fileURLToPath(import.meta.url)), '..', 'installer')

/** Replace exactly one maintained template anchor; template drift refuses packaging. */
function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Windows installer template changed: ${anchor}`)
  return source.replace(anchor, replacement)
}

/** Prepare the Windows-only script before electron-builder compiles NSIS.
 * @param context electron-builder's platform and project location.
 */
export default async function prepareWindowsInstaller(context) {
  if (context.electronPlatformName !== 'win32') return
  if (process.platform !== 'win32') throw new Error('Windows installers require a native Windows packaging runner')
  const projectDir = context.packager.projectDir
  const helperDll = await compileUninstallHelper(projectDir)
  await prepareWindowsInstallerScript(projectDir, await getPath7za(), {
    helperDll,
    updaterCacheName: context.packager.appInfo.updaterCacheDirName,
  })
}

/** Compile the native uninstall data helper the uninstaller embeds via System::Call.
 * @param projectDir Electron project directory.
 * @returns Absolute path to the compiled x86 DLL.
 */
async function compileUninstallHelper(projectDir) {
  const script = join(projectDir, 'scripts', 'prepare-windows-uninstall-helper.ps1')
  const output = join(projectDir, '.electron-build', 'nsis')
  const result = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputDirectory', output],
    { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Uninstall data helper compilation failed (exit ${result.status})`)
  return join(output, 'rivetdeck-uninstall.dll')
}

/** Project the stock uninstaller without its RMDir /r app-data bypass; the install-dir
 * removal keeps the extended-length prefix so deep installation directories still clean.
 * @param uninstaller Stock electron-builder uninstaller.nsh source.
 * @returns Uninstaller template restricted to install-directory removal.
 */
function directoryUninstaller(uninstaller) {
  const start = uninstaller.indexOf('  Var /GLOBAL isDeleteAppData\n')
  const end = uninstaller.indexOf('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', start)
  if (start < 0 || end < 0) throw new Error('Windows uninstaller template changed: delete-app-data block')
  return replaceOnce(uninstaller.slice(0, start) + uninstaller.slice(end),
    '    RMDir /r $INSTDIR', '    RMDir /r "\\\\?\\$INSTDIR"')
}

/** Emit LangString definitions for every bundled language; dictionary keys map through
 * toLangWithRegion and unspecified languages fall back to English.
 * @param messages Map of message id to per-language text from uninstall-messages.yml.
 * @returns uninstall-strings.nsh content.
 */
export function renderNsisStrings(messages) {
  const lines = []
  for (const [id, variants] of Object.entries(messages)) {
    for (const lang of bundledLanguages) {
      const text = variants[toLangWithRegion(lang)] ?? variants[lang]
        ?? variants[lang.split('_')[0]] ?? variants.en
      if (text == null) throw new Error(`Uninstall message ${id} is missing an en fallback`)
      // Escape $ first: doubling a literal dollar must not disturb the $\-escapes
      // emitted for quotes and newlines afterwards. ($$$$ in a JS replacement inserts
      // two literal dollars.)
      const escaped = String(text)
        .replaceAll('$', '$$$$')
        .replaceAll('"', '$\\"')
        .replaceAll(/\r\n?|\n/g, '$\\r$\\n')
      lines.push(`LangString ${id} ${lcid[lang]} "${escaped}"`)
    }
  }
  return lines.join('\n') + '\n'
}

/** The uninstaller flow: replacement and updates keep data, everything else flows through
 * the native helper with the recorded path history and env-derived protection.
 * @param options helperDll path and updaterCacheName from packaging metadata.
 * @returns uninstall.nsh content.
 */
function renderUninstallNsh({ helperDll, updaterCacheName }) {
  return `; Rivetdeck data cleanup: every deletion outside $INSTDIR goes through the native
; helper, which verifies path ownership and expected inventory, never descends into links,
; and reports residue rather than failing the uninstall.
; The custom include is parsed before the stock script pulls in these headers; both are
; include-guarded so the later stock includes stay inert.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define RIVETDECK_UNINSTALL_HELPER "${quoted(helperDll)}"
!define RIVETDECK_UPDATER_CACHE "${updaterCacheName}"
!define RIVETDECK_PATH_HISTORY "rivetdeck-path-history.ini"

!macro customInit
  ; installApplicationFiles stores a copy of this installer inside the updater cache
  ; (electron-builder's APP_INSTALLER_STORE_FILE), so by customInstall the cache always
  ; exists; legacy presence must be sampled during .onInit. Electron application data is
  ; always per-user: under an all-users shell context $LOCALAPPDATA is the shared root,
  ; so the sample runs in the current user's context exactly like the seed below.
  Var /GLOBAL rivetdeckLegacyUpdaterCache
  ${'${if}'} $installMode == "all"
    SetShellVarContext current
  ${'${endif}'}
  ${'${if}'} ${'${FileExists}'} "$LOCALAPPDATA\\${'${RIVETDECK_UPDATER_CACHE}'}"
    StrCpy $rivetdeckLegacyUpdaterCache "1"
  ${'${else}'}
    StrCpy $rivetdeckLegacyUpdaterCache "0"
  ${'${endif}'}
  ${'${if}'} $installMode == "all"
    SetShellVarContext all
  ${'${endif}'}
!macroend

!macro customInstall
  ; Fresh installs seed the record beside the default userData — a location the app can
  ; always write — so a later complete-removal request can prove coverage; an existing
  ; record survives updates and reinstalls untouched. The installation-mode flags cannot
  ; detect a fresh install — /currentuser forces them during initMultiUser.
  ; Electron application data is always per-user: under an all-users install this section
  ; runs with the "all" shell context, where $APPDATA resolves to ProgramData, so the
  ; seed must switch back to the current user's context exactly like the uninstall side.
  ; A prior installation, surviving userData, or an updater cache predating this install
  ; may hold an unrecorded Harness home, including after an older uninstall. Each
  ; requires incomplete history.
  Var /GLOBAL rivetdeckLegacyUpdaterCache
  ${'${if}'} $installMode == "all"
    SetShellVarContext current
  ${'${endif}'}
  ${'${IfNot}'} ${'${isUpdated}'}
  ${'${AndIfNot}'} ${'${FileExists}'} "$APPDATA\\${'${RIVETDECK_PATH_HISTORY}'}"
    FileOpen $0 "$APPDATA\\${'${RIVETDECK_PATH_HISTORY}'}" w
    ${'${If}'} $installationDir == ""
    ${'${AndIfNot}'} ${'${FileExists}'} "$APPDATA\\${'${APP_FILENAME}'}"
    ${'${AndIf}'} $rivetdeckLegacyUpdaterCache == "0"
      FileWrite $0 "complete=1$\\r$\\n"
    ${'${Else}'}
      FileWrite $0 "complete=0$\\r$\\n"
    ${'${EndIf}'}
    FileClose $0
  ${'${EndIf}'}
  ${'${if}'} $installMode == "all"
    SetShellVarContext all
  ${'${endif}'}
!macroend

!macro customUnInstall
  ; This file is parsed before multiUser.nsh declares installMode, so the shell-context
  ; switch happens here at the expansion site inside the uninstall section.
  ${'${if}'} $installMode == "all"
    SetShellVarContext current
  ${'${endif}'}
  Call un.RivetdeckCleanData
  ${'${if}'} $installMode == "all"
    SetShellVarContext all
  ${'${endif}'}
!macroend

!ifdef BUILD_UNINSTALLER
Var UnHome
Var UnTarget
Var UnHistory
Var UnResidue
Var UnMode

; A replaced or updating uninstaller never deletes data. The record beside the default
; userData is outside $INSTDIR, so it already survives for the succeeding install.
Function un.RivetdeckCleanData
  ; Command-line options are parsed with FileFunc rather than the StdUtils-backed flag
  ; macros: this function is compiled before the plugin directory registers StdUtils.
  ${'${GetParameters}'} $R0
  ClearErrors
  ${'${GetOptions}'} $R0 "--updated" $R1
  ${'${IfNot}'} ${'${Errors}'}
    Return
  ${'${EndIf}'}
  ; The installer runs an older uninstaller with /KEEP_APP_DATA when replacing it.
  ClearErrors
  ${'${GetOptions}'} $R0 "/KEEP_APP_DATA" $R1
  ${'${IfNot}'} ${'${Errors}'}
    Return
  ${'${EndIf}'}
  ClearErrors
  ${'${GetOptions}'} $R0 "--delete-app-data" $R1
  StrCpy $UnMode "0"
  ${'${IfNot}'} ${'${Errors}'}
    StrCpy $UnMode "1"
  ${'${EndIf}'}
  ReadEnvStr $UnHome DSH_HOME
  StrCpy $UnTarget "$APPDATA\\${'${APP_FILENAME}'}"
  StrCpy $UnResidue "$APPDATA\\${'${APP_FILENAME}'}-uninstall-residue.log"
  StrCpy $UnHistory "$APPDATA\\${'${RIVETDECK_PATH_HISTORY}'}"
  InitPluginsDir
  File "/oname=$PLUGINSDIR\\rivetdeck-uninstall.dll" "${'${RIVETDECK_UNINSTALL_HELPER}'}"
  ; NSIS 3.0.4.1 cannot quote DLL paths in System proc specs. Load the full path as
  ; a Unicode argument and call the resolved address so spaces and parentheses are safe.
  StrCpy $R5 "error"
  System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\\rivetdeck-uninstall.dll") p .R4'
  ${'${If}'} $R4 != 0
    System::Call 'kernel32::GetProcAddress(p R4, m "UninstallCleanup") p .R3'
    ${'${If}'} $R3 != 0
      System::Call '::$R3(w "$UnTarget", w "$INSTDIR", w "$UnHome", w "$UnHistory", w "$LOCALAPPDATA\\${'${RIVETDECK_UPDATER_CACHE}'}", w "$UnResidue", i $UnMode, *i .R6, *i .R7, *i .R9) i .R8 ?cr'
      Pop $R5
    ${'${EndIf}'}
    System::Call 'kernel32::FreeLibrary(p R4)'
  ${'${EndIf}'}
  ${'${If}'} $R5 != "ok"
    SetDetailsView show
    DetailPrint "$(RIVETDECK_UNINSTALL_HELPER_ERROR) $R5"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(RIVETDECK_UNINSTALL_HELPER_ERROR) $R5" /SD IDOK
    Return
  ${'${EndIf}'}
  ${'${If}'} $R8 != 0
  ${'${OrIf}'} $R9 != 0
    SetDetailsView show
    DetailPrint "$(RIVETDECK_UNINSTALL_ERROR) $R8"
    DetailPrint "$(RIVETDECK_UNINSTALL_SKIPPED) $R7"
    ${'${If}'} $R9 != 0
      DetailPrint "$(RIVETDECK_UNINSTALL_REPORT_ERROR) $R9"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(RIVETDECK_UNINSTALL_ERROR) $R8$\\r$\\n$(RIVETDECK_UNINSTALL_SKIPPED) $R7$\\r$\\n$(RIVETDECK_UNINSTALL_REPORT_ERROR) $R9" /SD IDOK
    ${'${Else}'}
      ${'${If}'} $R7 > 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(RIVETDECK_UNINSTALL_ERROR) $R8$\\r$\\n$(RIVETDECK_UNINSTALL_SKIPPED) $R7$\\r$\\n$UnResidue" /SD IDOK
      ${'${Else}'}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(RIVETDECK_UNINSTALL_ERROR) $R8$\\r$\\n$(RIVETDECK_UNINSTALL_SKIPPED) $R7" /SD IDOK
      ${'${EndIf}'}
    ${'${EndIf}'}
  ${'${EndIf}'}
  ${'${If}'} $R7 > 0
  ${'${AndIf}'} $R9 == 0
    DetailPrint "$(RIVETDECK_UNINSTALL_RESIDUE)"
    DetailPrint "$UnResidue"
  ${'${EndIf}'}
FunctionEnd
!endif
`
}

/** Generate the maintained template projection for one Windows packaging job.
 * @param projectDir Electron project directory.
 * @param sevenZip Verified Windows 7-Zip tool supplied by electron-builder.
 * @param options helperDll path and updaterCacheName for the cleanup uninstaller.
 */
export async function prepareWindowsInstallerScript(projectDir, sevenZip, options = {}) {
  const output = resolve(projectDir, '.electron-build/nsis')
  const helperDll = options.helperDll ?? join(output, 'rivetdeck-uninstall.dll')
  const updaterCacheName = options.updaterCacheName ?? 'rivetdeck-updater'
  await mkdir(output, { recursive: true })
  for (const file of await readdir(templates)) {
    if (file.endsWith('.nsh')) await copyFile(join(templates, file), join(output, file))
  }
  const extraction = await readFile(join(templates, 'include/extractAppPackage.nsh'), 'utf8')
  const unzip = '    nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"\n    Pop $R0\n    StrCmp $R0 "success" +3'
  const checkedExtraction = replaceOnce(extraction, unzip, `    File /oname=$PLUGINSDIR\\dsh-7za.exe "${quoted(sevenZip)}"\n    nsExec::ExecToLog '"$PLUGINSDIR\\dsh-7za.exe" x "$PLUGINSDIR\\app-$packageArch.zip" -o"$INSTDIR" -aoa -y'\n    Pop $R0\n    StrCmp $R0 "0" +4\n    SetErrorLevel 1`)
  await writeFile(join(output, 'extractAppPackage.nsh'), checkedExtraction)
  const installer = await readFile(join(templates, 'include/installer.nsh'), 'utf8')
  await writeFile(join(output, 'installer.nsh'), replaceOnce(installer, '!include "extractAppPackage.nsh"', `!include "${quoted(join(output, 'extractAppPackage.nsh'))}"`))
  const section = await readFile(join(templates, 'installSection.nsh'), 'utf8')
  await writeFile(join(output, 'installSection.nsh'), replaceOnce(section, '!include installer.nsh', `!include "${quoted(join(output, 'installer.nsh'))}"`))
  const uninstaller = await readFile(join(templates, 'uninstaller.nsh'), 'utf8')
  await writeFile(join(output, 'uninstaller.nsh'), directoryUninstaller(uninstaller))
  const messages = yaml.load(await readFile(join(installerResources, 'uninstall-messages.yml'), 'utf8'))
  await writeFile(join(output, 'uninstall-strings.nsh'), renderNsisStrings(messages))
  await writeFile(join(output, 'uninstall.nsh'), renderUninstallNsh({ helperDll, updaterCacheName }))
  // The current directory selects projected includes while electron-builder retains both signed compilation phases.
  await writeFile(join(output, 'include.nsh'),
    `!cd "${quoted(output)}"\n!include "${quoted(join(output, 'uninstall-strings.nsh'))}"\n!include "${quoted(join(output, 'uninstall.nsh'))}"\n`)
}
