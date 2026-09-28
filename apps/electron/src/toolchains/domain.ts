/** Desktop-managed runtimes are application assets, separate from the supervised Host runtime. */
export interface DesktopToolchainExecutable {
  executable: string
  version: string
}

/** Validated locations and versions passed from Electron Main to the Host. */
export interface DesktopToolchains {
  node: DesktopToolchainExecutable
  python: DesktopToolchainExecutable
  nodeBinDirectory: string
  pythonBinDirectory: string
  npmCli: string
  npxCli: string
}

/** Main-owned descriptor consumed by the Desktop subprocess provider. */
export interface DesktopToolchainPolicy {
  version: 1
  mode: 'fallback'
  basePath: string
  node: DesktopToolchainExecutable & { binDirectory: string }
  python: DesktopToolchainExecutable & { binDirectory: string }
  shimDirectory: string
  pythonUserBase: string
}
