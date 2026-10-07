import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
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
 * Render the Rivetdeck name without its independently slotted whale mark.
 * @returns the name wordmark.
 */
export function DesktopBrandName() {
  return (
    <svg width={112} height={24} viewBox="0 0 112 24" fill="currentColor" aria-hidden="true">
      <text
        x={0}
        y={18}
        fontSize={18}
        fontWeight={500}
        letterSpacing={0}
        style={{ fontFamily: 'var(--dsw-font-family-brand)' }}
      >
        Rivetdeck
      </text>
    </svg>
  )
}
