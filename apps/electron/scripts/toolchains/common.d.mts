export function validateArchiveMember(name: string, link?: string): void

export function unpackRuntime(archive: string, entry: { url: string; archive: string }, destination: string): Promise<void>
