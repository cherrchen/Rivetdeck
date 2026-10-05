/** Prepare an unsigned Store-only AppX configuration, manifest, and branded tile assets. */
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const builderRoot = dirname(builderRequire.resolve('app-builder-lib/package.json'))

/**
 * Validate Store identity and version independently of the desktop semver.
 * @param {unknown} value Partner Center identity and four-part package version.
 * @returns {{ identityName: string, publisher: string, publisherDisplayName: string, version: string, productId: string }} Validated submission metadata.
 */
export function validateStoreIdentity(value) {
  if (typeof value !== 'object' || value === null) throw new Error('windows-store.json must contain Store identity fields')
  const fields = ['identityName', 'publisher', 'publisherDisplayName', 'version', 'productId']
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].trim() !== value[field] || value[field].length === 0) {
      throw new Error(`windows-store.json requires a nonempty ${field} without surrounding whitespace`)
    }
  }
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(value.identityName)) throw new Error('Store identityName must match Package/Identity/Name from Partner Center')
  if (!value.publisher.startsWith('CN=')) throw new Error('Store publisher must match Package/Identity/Publisher from Partner Center')
  if (!/^[A-Z0-9]{12}$/.test(value.productId)) throw new Error('Store productId must be the 12-character Store ID')
  if (!/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.test(value.version)
    || value.version.split('.').some(part => Number(part) > 65535)) {
    throw new Error('Store version must be four integers from 0 to 65535, with a nonzero first part and a final 0')
  }
  return value
}

/**
 * Generate AppX inputs without changing NSIS defaults or the desktop application version.
 * @param {string} [projectDir] Electron application directory.
 * @returns {Promise<string>} Generated electron-builder JSON configuration path.
 */
export async function prepareWindowsStore(projectDir = root) {
  const [manifest, store] = await Promise.all([
    readFile(join(projectDir, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(projectDir, 'windows-store.json'), 'utf8').then(JSON.parse).then(validateStoreIdentity),
  ])
  const output = join(projectDir, '.electron-build/store')
  const resources = join(output, 'resources')
  await mkdir(join(resources, 'appx'), { recursive: true })
  const template = await readFile(join(builderRoot, 'templates/appx/appxmanifest.xml'), 'utf8')
  const values = { version: store.version, identityName: store.identityName, publisher: store.publisher, publisherDisplayName: store.publisherDisplayName }
  const appxManifest = template.replace(/\$\{(version|identityName|publisher|publisherDisplayName)\}/g, (_, key) => xmlText(values[key]))
  await writeFile(join(resources, 'AppxManifest.xml'), appxManifest)
  const tiles = [['StoreLogo.png', 50, 50], ['Square44x44Logo.png', 44, 44], ['Square150x150Logo.png', 150, 150], ['Wide310x150Logo.png', 310, 150]]
  for (const [filename, width, height] of tiles) {
    await sharp(join(projectDir, 'build/icon.png')).resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(resources, 'appx', filename))
  }
  const config = {
    ...manifest.build,
    extends: null,
    beforePack: null,
    publish: null,
    directories: { ...manifest.build.directories, output: '../../dist/electron-store', buildResources: resources },
    artifactName: `Rivetdeck-store-${store.version}-\${arch}.\${ext}`,
    extraMetadata: { ...manifest.build.extraMetadata, distribution: 'microsoft-store' },
    win: { ...manifest.build.win, icon: join(projectDir, 'build/icon.png'), target: ['appx'] },
    appx: {
      identityName: store.identityName,
      publisher: store.publisher,
      publisherDisplayName: store.publisherDisplayName,
      applicationId: 'Rivetdeck',
      displayName: manifest.productName,
      customManifestPath: join(resources, 'AppxManifest.xml'),
      languages: ['en-US', 'zh-CN'],
      minVersion: '10.0.17763.0',
      maxVersionTested: '10.0.26100.0',
      capabilities: ['runFullTrust'],
      addAutoLaunchExtension: false,
      electronUpdaterAware: false,
      setBuildNumber: false,
    },
  }
  delete config.nsis
  const configPath = join(output, 'builder.json')
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return configPath
}

function xmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareWindowsStore()
}
