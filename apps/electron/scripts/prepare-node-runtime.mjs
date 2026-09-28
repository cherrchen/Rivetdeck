/** Prepare the repository-pinned Node.js distribution. */
import { prepareToolchains } from './toolchains/prepare-toolchains.mjs'

await prepareToolchains('node')
