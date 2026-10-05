/** Workspace packages imported by desktop entry code outside the CLI production graph. */
export const DESKTOP_ENTRY_WORKSPACE_DEPENDENCIES = Object.freeze([
  '@deepseek-ai/dsh-client-web',
  '@deepseek-ai/dsh-config-editor',
  '@deepseek-ai/dsh-plugin-manager',
  // The network subprocess plugin extends this class; it is a CLI dependency, not a peer.
  '@deepseek-ai/dsh-subprocess-local',
])

/**
 * Replace generated workspace dependencies while retaining desktop-owned registry dependencies.
 *
 * A leftover `workspace:` specifier whose package is absent from the merged
 * workspace is dropped. The `workspace:` protocol cannot be fetched from npm.
 *
 * @param {Readonly<Record<string, string>> | undefined} currentDependencies
 * @param {readonly string[]} generatedWorkspaceDependencies
 * @param {ReadonlySet<string>} workspaceNames
 * @param {readonly string[]} requiredWorkspaceDependencies
 * @returns {Record<string, string>}
 */
export function synchronizeDependencies(
  currentDependencies,
  generatedWorkspaceDependencies,
  workspaceNames,
  requiredWorkspaceDependencies = [],
) {
  const retainedDependencies = Object.entries(currentDependencies ?? {})
    .filter(([name, specifier]) => !specifier.startsWith('workspace:') && !workspaceNames.has(name))
  const workspaceDependencies = [...new Set([
    ...generatedWorkspaceDependencies,
    ...requiredWorkspaceDependencies,
  ])]
    .map(name => [name, 'workspace:^'])

  return Object.fromEntries(
    [...retainedDependencies, ...workspaceDependencies]
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

/**
 * @param {Readonly<Record<string, string>>} dependencies
 * @param {ReadonlySet<string>} workspaceNames
 */
export function assertResolvedWorkspaceDependencies(dependencies, workspaceNames) {
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (specifier === 'workspace:^' && !workspaceNames.has(name)) {
      throw new Error(`Electron dependency ${name} is not present in the workspace`)
    }
  }
}

/**
 * Collect non-experimental workspace peers from the complete CLI production graph.
 * @param {ReadonlyMap<string, { dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }>} manifests - Workspace manifests indexed by package name.
 * @returns {string[]} Sorted non-experimental peer package names.
 */
export function collectWorkspacePeers(manifests) {
  const pending = ['@deepseek-ai/dsh']
  const visited = new Set()
  const peers = new Set()
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || visited.has(name)) continue
    visited.add(name)
    const manifest = manifests.get(name)
    if (manifest === undefined) continue
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (manifests.has(dependency)) pending.push(dependency)
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (!manifests.has(dependency)) continue
      if (!dependency.startsWith('@deepseek-ai/dsh-experimental-')) peers.add(dependency)
      pending.push(dependency)
    }
  }
  return [...peers].sort()
}
