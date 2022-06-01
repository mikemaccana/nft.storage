const path = require('path')
const dotenv = require('dotenv')
const execa = require('execa')
const delay = require('delay')
const { once } = require('events')
const temp = require('temp')
const fs = require('fs')

/** @typedef {{ proc: execa.ExecaChildProcess<string> }} ProcessObject */

dotenv.config({ path: path.join(__dirname, '../../.env') })

// write DATABASE_URL and CLUSTER_API_URL from the environment
// to a js file that can be injected using esbuild.
const configOverridesJs = `
globalThis.DATABASE_URL = "${process.env.DATABASE_URL}"
globalThis.CLUSTER_API_URL = "${process.env.CLUSTER_API_URL || ''}"
`

temp.track()
const { path: configOverridePath, fd: configOverrideFile } = temp.openSync({
  prefix: 'nftstorage-test',
  suffix: '.js',
})
fs.writeSync(configOverrideFile, configOverridesJs)
fs.closeSync(configOverrideFile)

const cli = path.join(__dirname, 'scripts/cli.js')
/** @type {import('esbuild').Plugin} */
const nodeBuiltinsPlugin = {
  name: 'node builtins',
  setup(build) {
    build.onResolve({ filter: /^stream$/ }, () => {
      return { path: require.resolve('readable-stream') }
    })
  },
}

/** @type {import('playwright-test').RunnerOptions} */
module.exports = {
  buildConfig: {
    inject: [
      path.join(__dirname, './scripts/node-globals.js'),
      configOverridePath,
    ],
    plugins: [nodeBuiltinsPlugin],
  },
  buildSWConfig: {
    inject: [
      path.join(__dirname, './scripts/node-globals.js'),
      configOverridePath,
    ],
    plugins: [nodeBuiltinsPlugin],
  },
  beforeTests: async () => {
    const mock = await startMockServer('AWS S3', 9095, 'test/mocks/aws-s3')
    return { mock }
  },
  afterTests: async (
    ctx,
    /** @type {{  mock: ProcessObject }} */ beforeTests
  ) => {
    console.log('⚡️ Shutting down mock servers.')

    beforeTests.mock.proc.kill()
  },
}

/**
 * @param {string} name
 * @param {number} port
 * @param {string} handlerPath
 * @returns {Promise<ProcessObject>}
 */
async function startMockServer(name, port, handlerPath) {
  const proc = execa('smoke', ['-p', String(port), handlerPath], {
    preferLocal: true,
  })
  if (!proc.stdout || !proc.stderr) {
    throw new Error('missing process stdio stream(s)')
  }

  const stdout = await Promise.race([
    once(proc.stdout, 'data'),
    // Make sure that we fail if process crashes. However if it exits without
    // producing stdout just resolve to ''.
    proc.then(() => ''),
  ])

  proc.stdout.on('data', (line) => console.log(line.toString()))
  proc.stderr.on('data', (line) => console.error(line.toString()))

  const startMsg = `Server started on: http://localhost:${port}`
  if (!stdout.toString().includes(startMsg)) {
    throw new Error(`Failed to start ${name} mock server`)
  }

  console.log(`⚡️ Mock ${name} started.`)
  return { proc }
}
