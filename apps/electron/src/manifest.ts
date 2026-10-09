import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateRepository } from './update-feed.ts'

/** Package metadata consumed by desktop-owned integrations. */
export interface DesktopManifest {
  distribution?: unknown
  build?: unknown
  homepage?: unknown
  repository?: unknown
}

/**
 * Resolve Store-managed updates from stamped artifacts or Windows package identity.
 * @param manifest - Packaged application metadata.
 * @param windowsStore - Electron's installed Windows package detection.
 * @returns Whether GitHub updating must be disabled, including unpacked Store artifacts.
 */
export function usesStoreUpdates(manifest: DesktopManifest, windowsStore: boolean): boolean {
  return windowsStore || manifest.distribution === 'microsoft-store'
}

/**
 * Read the packaged desktop manifest.
 * @param appPath - Electron application root.
 * @returns Parsed metadata, or an empty manifest when unreadable.
 */
export function readDesktopManifest(appPath: string): DesktopManifest {
  try {
    return JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as DesktopManifest
  } catch {
    return {}
  }
}

/** Resolve the GitHub publish target from source or packaged metadata. */
export function resolveUpdateRepository(manifest: DesktopManifest): UpdateRepository | undefined {
  if (isRecord(manifest.build)) {
    const publishValue: unknown = manifest.build.publish
    const publish: unknown = Array.isArray(publishValue) ? publishValue[0] : publishValue
    if (isRecord(publish)
      && publish.provider === 'github'
      && typeof publish.owner === 'string'
      && typeof publish.repo === 'string') return { owner: publish.owner, repo: publish.repo }
  }

  const repository = manifest.repository
  const repositoryUrl = typeof repository === 'string'
    ? repository
    : isRecord(repository) && typeof repository.url === 'string'
      ? repository.url
      : undefined
  if (repositoryUrl === undefined) return undefined
  try {
    const url = new URL(repositoryUrl.replace(/^git\+/, ''))
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
    const segments = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
    if (segments.length !== 2) return undefined
    const [owner, repo] = segments
    if (owner === undefined || repo === undefined) return undefined
    return { owner, repo }
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
