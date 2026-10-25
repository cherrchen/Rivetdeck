/** Keep runtime packages reachable through repeated pnpm workspace entries. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'

interface Dependency {
  name: string
  version: string
  path: string
  dependencies?: Record<string, Dependency>
  optionalDependencies?: Record<string, Dependency>
  dedupedDependenciesCount?: number
}

/** Internal collector operations covered by the maintained builder patch. */
interface Collector {
  allDependencies: Map<string, Dependency>
  collectDepsRecursively(tree: Pick<Dependency, 'dependencies' | 'optionalDependencies'>): Promise<void>
  locateFromDepOrRoot(name: string, parentPath: string, version: string): Promise<{
    packageDir: string
    packageJson: { name: string; version: string }
  }>
}

const require = createRequire(join(import.meta.dirname, '../package.json'))
const builderRequire = createRequire(require.resolve('electron-builder'))
const { PnpmNodeModulesCollector } = builderRequire('app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector.js') as {
  PnpmNodeModulesCollector: new (root: string) => Collector
}

it.each(['dependencies', 'optionalDependencies'] as const)('collects runtime children from a repeated workspace entry under %s', async (section) => {
  const root = join(import.meta.dirname, 'collector-fixture')
  const collector = new PnpmNodeModulesCollector(root)
  collector.locateFromDepOrRoot = async (name, _parentPath, version) => ({
    packageDir: join(root, name), packageJson: { name, version },
  })
  const shared = { name: 'workspace-entry', version: 'link:../workspace-entry', path: join(root, 'workspace-entry') }
  await collector.collectDepsRecursively({
    dependencies: {
      first: {
        name: 'first', version: '1.0.0', path: join(root, 'first'),
        dependencies: { 'workspace-entry': { ...shared, dedupedDependenciesCount: 1 } },
      },
      second: {
        name: 'second', version: '1.0.0', path: join(root, 'second'),
        [section]: {
          'workspace-entry': {
            ...shared,
            dependencies: {
              'runtime-leaf': { name: 'runtime-leaf', version: '1.0.0', path: join(root, 'runtime-leaf') },
            },
          },
        },
      },
    },
  })
  expect(collector.allDependencies.has('runtime-leaf@1.0.0')).toBe(true)
  expect(collector.allDependencies.get('workspace-entry@link:../workspace-entry')?.dependencies).toHaveProperty('runtime-leaf')
})
