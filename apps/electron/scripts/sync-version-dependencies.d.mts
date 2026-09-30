/** Workspace packages imported by desktop entry code outside the CLI production graph. */
export const DESKTOP_ENTRY_WORKSPACE_DEPENDENCIES: readonly string[]

/**
 * Replace generated workspace dependencies while retaining desktop-owned registry dependencies.
 * Drops leftover `workspace:` specifiers whose packages are absent from the workspace.
 */
export function synchronizeDependencies(
  currentDependencies: Readonly<Record<string, string>> | undefined,
  generatedWorkspaceDependencies: readonly string[],
  workspaceNames: ReadonlySet<string>,
  requiredWorkspaceDependencies?: readonly string[],
): Record<string, string>

/** Reject generated workspace dependencies whose packages are absent. */
export function assertResolvedWorkspaceDependencies(
  dependencies: Readonly<Record<string, string>>,
  workspaceNames: ReadonlySet<string>,
): void

/**
 * Collect non-experimental workspace peers from the complete CLI production graph.
 * @param manifests - Workspace manifests indexed by package name.
 * @returns Sorted non-experimental peer package names.
 */
export function collectWorkspacePeers(
  manifests: ReadonlyMap<string, {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }>,
): string[]
