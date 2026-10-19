/** Pre-Host maintenance ordering, including journals created by this launch's restores. */

/**
 * Keep the Host stopped until restore journals pass the startup decision.
 * Detection and prompt errors are reported before the final journal check.
 * @param options - Journal decision, restore work, and maintenance error reporter.
 * @returns Whether the caller may start the Host.
 */
export async function runStartupSessionMaintenance(options: {
  readonly gate: () => Promise<boolean>
  readonly maintain: () => Promise<void>
  readonly onError: (error: unknown) => void
}): Promise<boolean> {
  if (!await options.gate()) return false
  try {
    await options.maintain()
  } catch (error) {
    options.onError(error)
  }
  return options.gate()
}
