/** Observable activation and disposal for the real profile package fixture. */
import { appendFileSync } from 'node:fs'

/** Record each owned effect's lifetime. */
export function apply(ctx, config) {
  ctx.effect(() => {
    appendFileSync(config.events, 'active 1.5.0\n')
    return () => { appendFileSync(config.events, 'disposed 1.5.0\n') }
  })
}
