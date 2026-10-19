// IPC barriers keep each process paused after its first history read so the parent can
// reproduce stale reads without relying on process scheduling.
import fs from 'node:fs/promises'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'

const [appDataDir, userData, dshHome] = process.argv.slice(2)
const read = fs.readFile
const write = fs.writeFile
let reportedContention = false
fs.readFile = async (...args) => {
  const result = await read(...args)
  if (String(args[0]).endsWith('rivetdeck-path-history.ini')) {
    const release = once(process, 'message')
    process.send('read')
    await release
  }
  return result
}
fs.writeFile = async (...args) => {
  try {
    return await write(...args)
  } catch (error) {
    if (String(args[0]).endsWith('.lock') && !reportedContention
      && ['EEXIST', 'EPERM'].includes(error.code)) {
      reportedContention = true
      process.send('contended')
    }
    throw error
  }
}
syncBuiltinESMExports()
const { mergeLaunchPathHistory } = await import('../../src/path-history.ts')
await mergeLaunchPathHistory({ appDataDir, userData, dshHome })
process.disconnect()
