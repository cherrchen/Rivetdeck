/** Native update menu shared by the application and tray in Store builds. */
import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopMainMessages } from './locale.ts'

/**
 * Present Store ownership without GitHub channel or installation actions.
 * @param messages - Main-process locale dictionary.
 * @returns Disabled informational menu row.
 */
export function microsoftStoreUpdateMenu(messages: DesktopMainMessages): MenuItemConstructorOptions[] {
  return [{ label: messages.menuStoreUpdates, enabled: false }]
}
