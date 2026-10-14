#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const electronManifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const runtimePluginsRoot = fileURLToPath(new URL('../runtime/plugins', import.meta.url))

/** @param {string} raw */
function normalizeVersion(raw) {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error('Version argument is required.')
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
}

/** @param {string} version */
function assertSemver(version) {
  const pattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/
  if (!pattern.test(version)) {
    throw new Error(`Version ${version} is not a supported desktop release version.`)
  }
}

/**
 * Bundled runtime plugin manifests track the application version.
 * @param {string} version
 */
async function syncRuntimePluginVersions(version) {
  if (!existsSync(runtimePluginsRoot)) return
  for (const entry of await readdir(runtimePluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(runtimePluginsRoot, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.version === version) continue
    manifest.version = version
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`Runtime plugin ${manifest.name ?? entry.name} set to ${version}`)
  }
}

const version = normalizeVersion(process.argv[2] ?? '')
assertSemver(version)

const electronManifest = JSON.parse(await readFile(electronManifestPath, 'utf8'))
if (electronManifest.version === version) {
  console.log(`Electron manifest already at ${version}`)
} else {
  electronManifest.version = version
  await writeFile(electronManifestPath, `${JSON.stringify(electronManifest, null, 2)}\n`)
  console.log(`Electron manifest set to ${version}`)
}

await syncRuntimePluginVersions(version)
