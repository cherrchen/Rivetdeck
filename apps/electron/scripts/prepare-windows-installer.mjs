/** Build the maintained NSIS templates with checked, long-path-capable ZIP extraction. */
import { createRequire } from 'node:module'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const templates = join(dirname(libraryRequire.resolve('app-builder-lib/package.json')), 'templates/nsis')
const { getPath7za } = libraryRequire('app-builder-lib/out/toolsets/7zip.js')
// NSIS splits include paths on the native separator; Windows includes require backslashes.
const quoted = path => path.replaceAll('$', '$$')

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
  await prepareWindowsInstallerScript(context.packager.projectDir, await getPath7za())
}

/** Generate the maintained template projection for one Windows packaging job.
 * @param projectDir Electron project directory.
 * @param sevenZip Verified Windows 7-Zip tool supplied by electron-builder.
 */
export async function prepareWindowsInstallerScript(projectDir, sevenZip) {
  const output = resolve(projectDir, '.electron-build/nsis')
  await mkdir(output, { recursive: true })
  for (const file of await readdir(templates)) {
    if (file.endsWith('.nsh')) await copyFile(join(templates, file), join(output, file))
  }
  const extraction = await readFile(join(templates, 'include/extractAppPackage.nsh'), 'utf8')
  const unzip = '    nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"\n    Pop $R0\n    StrCmp $R0 "success" +3'
  const checkedExtraction = replaceOnce(extraction, unzip, `    File /oname=$PLUGINSDIR\\dsh-7za.exe "${quoted(sevenZip)}"\n    nsExec::ExecToLog '\"$PLUGINSDIR\\dsh-7za.exe\" x \"$PLUGINSDIR\\app-$packageArch.zip\" -o\"$INSTDIR\" -aoa -y'\n    Pop $R0\n    StrCmp $R0 "0" +4\n    SetErrorLevel 1`)
  await writeFile(join(output, 'extractAppPackage.nsh'), checkedExtraction)
  const installer = await readFile(join(templates, 'include/installer.nsh'), 'utf8')
  await writeFile(join(output, 'installer.nsh'), replaceOnce(installer, '!include "extractAppPackage.nsh"', `!include "${quoted(join(output, 'extractAppPackage.nsh'))}"`))
  const section = await readFile(join(templates, 'installSection.nsh'), 'utf8')
  await writeFile(join(output, 'installSection.nsh'), replaceOnce(section, '!include installer.nsh', `!include "${quoted(join(output, 'installer.nsh'))}"`))
  // The current directory selects projected includes while electron-builder retains both signed compilation phases.
  await writeFile(join(output, 'include.nsh'), `!cd "${quoted(output)}"\n`)
}
