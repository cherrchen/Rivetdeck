import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type DesktopBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the DeepSeek Harness mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the whale mark.
 */
export function DesktopBrandMark({ size, className }: DesktopBrandMarkProps) {
  return <FishLogo size={size} className={className} />
}

/**
 * Render the DeepSeek Harness name artwork without its independently slotted mark.
 * @returns the name wordmark.
 */
export function DesktopBrandName() {
  return <BrandWordmark includeMark={false} />
}
