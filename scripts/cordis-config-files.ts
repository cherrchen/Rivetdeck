/** Cordis Loader configuration file discovery. */

import { execFileSync } from 'node:child_process'
import { globSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * Return repository-relative Cordis Loader YAML paths under `root`.
 *
 * Translation consistency records are YAML sidecars, never Loader inputs.
 *
 * @param root Repository root to scan.
 * @returns Sorted repository-relative Loader configuration paths.
 */
export function cordisConfigFiles(root: string): string[] {
  return globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
    cwd: root,
    exclude: ['.claude/**', 'node_modules/**', 'vendor/**', '**/*.i18n.yaml'],
  }).sort()
}

/** Read Loader YAML, including Git symlinks checked out as text without Windows symlink privileges.
 * @param root Repository root containing the configuration and its target.
 * @param file Repository-relative configuration path.
 * @returns YAML text from the configuration's final target.
 */
export function readCordisConfig(root: string, file: string): string {
  const seen = new Set<string>()
  let path = resolve(root, file)
  for (;;) {
    const rel = relative(root, path)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error(`Cordis config target escapes repository: ${file}`)
    if (seen.has(path)) throw new Error(`Cyclic Cordis config link: ${file}`)
    seen.add(path)
    const source = readFileSync(path, 'utf8')
    if (lstatSync(path).isSymbolicLink()) return source
    const record = execFileSync('git', ['ls-files', '--stage', '-z', '--', rel], { cwd: root, encoding: 'utf8' })
    if (!record.startsWith('120000 ')) return source
    path = resolve(dirname(path), source.trim())
  }
}
