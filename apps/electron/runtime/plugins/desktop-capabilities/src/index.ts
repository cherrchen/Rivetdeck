/** Refresh the Desktop ownership overlay whenever the Host recomposes its profile. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { generateOwnershipOverlay } from '../../../../src/ownership-overlay.ts'

/**
 * Install the profile overlay reader for the lifetime of Desktop Capabilities.
 * @param ctx - Host plugin context with the supervised web profile.
 */
export function apply(ctx: Context): void {
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('Desktop Capabilities requires a dsh profile')
  const descriptor = Object.getOwnPropertyDescriptor(profile, 'overlays')
  if (descriptor === undefined) throw new Error('Desktop Capabilities requires profile overlays')
  const appPath = fileURLToPath(new URL('../../../..', import.meta.url))
  ctx.effect(() => {
    Object.defineProperty(profile, 'overlays', {
      configurable: true,
      enumerable: true,
      get: (): readonly PatchOptions[] => readOwnershipPatches(appPath, profile),
    })
    return () => { Object.defineProperty(profile, 'overlays', descriptor) }
  }, 'desktop ownership overlay')
}

function readOwnershipPatches(appPath: string, profile: ProfileContext): PatchOptions[] {
  const parsed: unknown = load(generateOwnershipOverlay(appPath, profile.home))
  if (!Array.isArray(parsed)) throw new Error('Desktop ownership overlay must be a patch list')
  return parsed as PatchOptions[]
}
