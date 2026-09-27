/** Open the upstream Settings shell through its visible controls. */
export function openNetworkSettings(triggerLabel: string, sectionLabel: string): () => void {
  let triggerClicked = false
  const attempt = () => {
    if (!triggerClicked) {
      const trigger = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
        .find(button => button.getAttribute('aria-label') === triggerLabel)
      if (trigger === undefined) return
      triggerClicked = true
      trigger.click()
    }
    const panel = document.querySelector('[role="dialog"] nav')
    const section = [...(panel?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find(button => button.textContent?.trim() === sectionLabel)
    if (section === undefined) return
    section.click()
    observer.disconnect()
  }
  const observer = new MutationObserver(attempt)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  attempt()
  return () => { observer.disconnect() }
}
