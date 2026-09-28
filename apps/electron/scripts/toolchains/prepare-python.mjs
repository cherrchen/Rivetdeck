import { join } from 'node:path'
import { prepare, run, updateCurrent } from './common.mjs'

export function pythonExecutable(root, targetName) {
  return join(root, targetName.startsWith('win32-') ? 'python.exe' : 'bin/python3')
}

export async function preparePython(lock, targetName) {
  const entry = lock.python.targets[targetName]
  const root = await prepare('python', targetName, entry, path => pythonExecutable(path, targetName), path => {
    const executable = pythonExecutable(path, targetName)
    run(executable, ['--version'], `Python ${lock.python.version}`)
    run(executable, ['-c', 'import sys; print(sys.executable)'])
    run(executable, ['-c', 'import ssl, sqlite3, ctypes'])
    run(executable, ['-m', 'pip', '--version'])
  })
  updateCurrent('python', root, entry)
  return root
}
