import lock from '../../toolchains.lock.json' with { type: 'json' }

export function loadManifest(): typeof lock
export function validateManifest(value: typeof lock): typeof lock
