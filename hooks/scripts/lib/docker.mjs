// hooks/scripts/lib/docker.mjs
// Docker container management for Agents Observe. Node.js built-ins only.

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getJson } from './http.mjs'
import { initLocalDataDirs, getServerEnv } from './config.mjs'
import { saveServerPortFile, removeServerPortFile } from './fs.mjs'

// -- Shell helper -------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: stdout?.trim() || '',
        stderr: stderr?.trim() || '',
      })
    })
  })
}

/**
 * Read the managed label value from a container.
 * Returns the label string (version) if it's our container, null otherwise.
 */
async function getContainerLabel(config, labelName = config.dockerLabel) {
  const result = await run('docker', [
    'inspect',
    '--format',
    `{{index .Config.Labels "${labelName}"}}`,
    config.containerName,
  ])
  return result.ok && result.stdout ? result.stdout : null
}

/**
 * Check if a container exists and is managed by us.
 */
async function isOurContainer(config) {
  return !!(await getContainerLabel(config))
}

/**
 * Force-remove a container, but only if it has our managed label.
 * Returns true if removed, false if skipped (not ours or doesn't exist).
 */
async function safeRemoveContainer(config, log) {
  if (!(await isOurContainer(config))) {
    const exists = await run('docker', ['inspect', config.containerName])
    if (exists.ok) {
      log.warn(
        `Container "${config.containerName}" exists but is not managed by ${config.dockerLabel} — skipping removal`,
      )
    }
    return false
  }
  await run('docker', ['rm', '-f', config.containerName])
  return true
}

/**
 * Get the status of our container (if it exists).
 * Returns { exists, running, versionMatch } or null if container doesn't exist.
 */
async function getContainerState(config) {
  const label = await getContainerLabel(config)
  if (!label) return null

  const statusResult = await run('docker', [
    'inspect',
    '--format',
    '{{.State.Running}}',
    config.containerName,
  ])
  const running = statusResult.ok && statusResult.stdout === 'true'
  const versionMatch = label === (config.expectedVersion || 'unknown')

  const redactLabel = (await getContainerLabel(config, REDACT_LABEL)) || ''

  return { exists: true, running, versionMatch, labelVersion: label, redactLabel }
}

/**
 * Single `docker inspect` for the healthy-server path. Returns the redact label
 * ('' when missing) only if the container is ours AND running, else null.
 */
async function getRunningRedactLabel(config) {
  const result = await run('docker', [
    'inspect',
    '--format',
    `{{.State.Running}}|{{index .Config.Labels "${config.dockerLabel}"}}|{{index .Config.Labels "${REDACT_LABEL}"}}`,
    config.containerName,
  ])
  if (!result.ok) return null
  const [running, managed, redact] = result.stdout.split('|')
  if (running !== 'true' || !managed) return null
  return redact || ''
}

/**
 * Decide what to do about a changed redaction-patterns config. Pure.
 *   containerState: null (no managed container) | 'running' | 'stopped'
 *   actualLabel / desiredLabel: redact label values ('' = none; undefined = ''
 *   for containers that predate the label)
 * Returns:
 *   'none'     nothing to do
 *   'warn'     a healthy shared server runs with a different config: never
 *              recreate it (other sessions use it), tell the user to restart
 *   'recreate' a stopped container would be restarted with a stale config
 * A running container that is not the healthy server is left to the existing
 * unhealthy-container path, which recreates it with the current label.
 */
export function decideRedactAction({ serverHealthy, containerState, actualLabel, desiredLabel }) {
  if (!containerState) return 'none'
  if ((actualLabel || '') === (desiredLabel || '')) return 'none'
  if (serverHealthy) return containerState === 'running' ? 'warn' : 'none'
  return containerState === 'stopped' ? 'recreate' : 'none'
}

// -- Docker lifecycle ---------------------------------------------

/**
 * Build the `-p` value for `docker run`. Prefixes the host interface so the
 * published port binds to loopback by default rather than 0.0.0.0, keeping
 * the unauthenticated dashboard/WebSocket off other interfaces (GitHub
 * issue #22). Pass hostPort `0` to let docker auto-assign a free host port.
 * An empty bindHost falls back to docker's default (all interfaces).
 */
export function buildPortMapping(bindHost, hostPort, containerPort) {
  return bindHost ? `${bindHost}:${hostPort}:${containerPort}` : `${hostPort}:${containerPort}`
}

/**
 * Build the `-v` value for the writable data mount. On SELinux hosts the
 * bind-mounted dir keeps its host label and the confined container can't write
 * to it, so the sqlite DB fails to open (SQLITE_CANTOPEN — GitHub issue #20).
 * Appending `z` relabels the dir to the shared container-accessible type. This
 * dir is ours (`<data root>/data`, only the DB + logs), so relabeling it
 * recursively is safe.
 */
export function buildDataMount(dataDir, relabel = false) {
  return `${dataDir}:/data${relabel ? ':z' : ''}`
}

/**
 * Build the `-v` args for the read-only transcript bind mounts (one per
 * agent class). Returns a flat array suitable for `docker run`, e.g.
 * `['-v', '<host>:/host/.claude/projects:ro', ...]`.
 *
 * Filters on the host path directly rather than parsing it back out of the
 * joined mount string. A Windows host path (`C:\Users\...`) contains the
 * drive-letter colon, so splitting the mount on `:` mistook the drive letter
 * for the source and silently dropped both mounts — GitHub issue #21.
 *
 * When `relabel` is set, appends the shared SELinux relabel option (`,z`) so
 * the container can read these dirs on SELinux hosts (issue #20). These are
 * the user's ~/.claude and ~/.codex dirs, so `z` (shared) is used — never `Z`
 * (private) — and it can be disabled via AGENTS_OBSERVE_SELINUX_RELABEL.
 *
 * `exists` is injectable so the filter can be unit-tested with Windows-style
 * paths on a POSIX host.
 */
export function buildTranscriptMounts(
  { claudeHost, codexHost, enabled, relabel = false },
  exists = existsSync,
) {
  if (!enabled) return []
  const opts = relabel ? 'ro,z' : 'ro'
  return [
    { host: claudeHost, container: '/host/.claude/projects' },
    { host: codexHost, container: '/host/.codex/sessions' },
  ]
    .filter(({ host }) => host && exists(host))
    .flatMap(({ host, container }) => ['-v', `${host}:${container}:${opts}`])
}

/** Fixed container-side path of the optional redaction-patterns file. */
export const REDACT_PATTERNS_CONTAINER_PATH = '/app/redact-patterns.json'

/**
 * Build the `docker run` args for the optional redaction-patterns file.
 * Returns `{ args, warning }`. `args` is empty when the path is unset or is not
 * an existing regular file (then `warning` explains why; startup continues).
 * Mounts the single file read-only, never a directory. The file content is
 * never read or logged, and only the path appears in the warning.
 * `stat` is injectable for tests.
 */
export function buildRedactPatternsArgs({ hostPath, relabel = false }, stat = statSync) {
  if (!hostPath) return { args: [], warning: null }
  let isFile = false
  try {
    isFile = stat(hostPath).isFile()
  } catch {
    // missing or unreadable: handled below
  }
  if (!isFile) {
    return {
      args: [],
      warning: `AGENTS_OBSERVE_REDACT_PATTERNS_PATH "${hostPath}" is not an existing regular file, continuing without it`,
    }
  }
  return {
    args: [
      '-v',
      `${hostPath}:${REDACT_PATTERNS_CONTAINER_PATH}:${relabel ? 'ro,z' : 'ro'}`,
      '-e',
      `AGENTS_OBSERVE_REDACT_PATTERNS_PATH=${REDACT_PATTERNS_CONTAINER_PATH}`,
    ],
    warning: null,
  }
}

/** Container label recording which redaction-patterns file it was created with. */
export const REDACT_LABEL = 'agents-observe.redact'

/**
 * Label value for the redaction config: a short hash of the host path (so the
 * path is not exposed in labels), or '' when no valid file is configured.
 */
export function redactLabelValue(hostPath, valid) {
  if (!hostPath || !valid) return ''
  return createHash('sha256').update(hostPath).digest('hex').slice(0, 16)
}

/**
 * Pure builder for the full `docker run` argv. `redact` is the result of
 * buildRedactPatternsArgs. `exists` is injectable for the transcript mounts.
 */
export function buildDockerRunArgs(
  { config, serverEnv, portMapping, redact, redactLabel },
  exists = existsSync,
) {
  const envArgs = Object.entries(serverEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const labelValue = config.expectedVersion || 'unknown'
  // One mount per supported agent class. Each can resolve to a
  // different host path (user override) but the container side is
  // fixed so the server's resolveTranscriptPath knows where things
  // land. Missing host paths are silently skipped so e.g. a user
  // without codex installed doesn't error out.
  const transcriptMounts = buildTranscriptMounts(
    {
      claudeHost: config.transcriptClaudeHost,
      codexHost: config.transcriptCodexHost,
      enabled: config.transcriptStatsEnabled,
      relabel: config.selinuxRelabel,
    },
    exists,
  )
  return [
    'run',
    '-d',
    '--name',
    config.containerName,
    '--label',
    `${config.dockerLabel}=${labelValue}`,
    '--label',
    `${REDACT_LABEL}=${redactLabel || ''}`,
    '-p',
    portMapping,
    ...envArgs,
    '-v',
    buildDataMount(config.dataDir, config.selinuxRelabel),
    ...transcriptMounts,
    ...redact.args,
    config.dockerImage,
  ]
}

/**
 * Pure decision for a healthy server answering on the target port.
 *   ownRunningLabel: redact label of OUR running managed container, or null if
 *   the healthy server is not our running container (dev server, other
 *   worktree, etc).
 * Returns 'other-service' | 'version-recreate' | 'recreate' |
 * 'warn-cannot-restart' | 'warn-redact' | 'return-port'. Without `recreate` it
 * never returns 'recreate'. 'recreate' needs docker runtime AND our own
 * running container.
 */
export function decideHealthyAction({
  idMatch,
  versionMatch,
  recreate,
  runtime,
  ownRunningLabel,
  desiredLabel,
}) {
  if (!idMatch) return 'other-service'
  if (!versionMatch) return 'version-recreate'
  if (recreate) {
    return runtime === 'docker' && ownRunningLabel !== null ? 'recreate' : 'warn-cannot-restart'
  }
  const redactAction = decideRedactAction({
    serverHealthy: true,
    containerState: ownRunningLabel === null ? null : 'running',
    actualLabel: ownRunningLabel,
    desiredLabel,
  })
  return redactAction === 'warn' ? 'warn-redact' : 'return-port'
}

/**
 * Pull the image. With `allowLocal`, a failed pull is non-fatal when the image
 * already exists locally. Returns true if the image is usable. Skipped in the
 * test harness (AGENTS_OBSERVE_TEST_SKIP_PULL=1).
 */
async function ensureImage(config, log, allowLocal) {
  if (config.testSkipPull) {
    log.info('AGENTS_OBSERVE_TEST_SKIP_PULL=1 — skipping docker pull (test harness)')
    return true
  }
  log.info('Pulling image and starting container...')
  const pullResult = await run('docker', ['pull', config.dockerImage])
  if (pullResult.ok) return true
  if (allowLocal && (await run('docker', ['image', 'inspect', config.dockerImage])).ok) {
    log.warn(`Failed to pull image, using local copy: ${pullResult.stderr}`)
    return true
  }
  log.error(`Failed to pull image: ${pullResult.stderr}`)
  return false
}

/**
 * Starts the Docker container. Returns the actual port the server is running on.
 * Handles: version mismatch (restart), port conflict (auto-assign), stale containers.
 *
 * Fast path: if a stopped container exists with the correct version, just
 * `docker start` it instead of rm + pull + run.
 */
export async function startServer(config, log = console, opts = {}) {
  // Check Docker availability
  const dockerCheck = await run('docker', ['info'])
  if (!dockerCheck.ok) {
    log.error('ERROR: Docker is not running or not installed')
    log.error('Install Docker: https://docs.docker.com/get-docker/')
    return null
  }

  // Optional redaction-patterns file. The desired label value ('' when unset or
  // invalid) is compared with the existing container so a changed config
  // recreates it, like a version mismatch.
  const redact = buildRedactPatternsArgs({
    hostPath: config.redactPatternsPath,
    relabel: config.selinuxRelabel,
  })
  if (redact.warning) log.warn(redact.warning)
  const redactLabel = redactLabelValue(config.redactPatternsPath, redact.args.length > 0)

  // Track whether we removed a container (so a failed fresh start can clean up
  // the port file) and whether the image was already pulled (recreate path).
  let removedAny = false
  let pulled = false
  const removeOurs = async () => {
    if (await safeRemoveContainer(config, log)) removedAny = true
  }
  const failStart = () => {
    if (removedAny) removeServerPortFile(config)
    return null
  }

  // Check if something is already running on the target port
  const healthResult = await getJson(`${config.apiBaseUrl}/health`)
  if (healthResult.status === 200 && healthResult.body?.ok) {
    const idMatch = healthResult.body.id === config.API_ID
    const versionMatch =
      !config.expectedVersion || healthResult.body.version === config.expectedVersion
    // One read of our own container's redact label, only when it could matter.
    const ownRunningLabel = idMatch && versionMatch ? await getRunningRedactLabel(config) : null
    const action = decideHealthyAction({
      idMatch,
      versionMatch,
      recreate: !!opts.recreate,
      runtime: config.runtime,
      ownRunningLabel,
      desiredLabel: redactLabel,
    })
    const healthyPort = new URL(config.apiBaseUrl).port || '4981'
    if (action === 'other-service') {
      log.warn(
        `Port ${config.serverPort} is in use by another service, auto-assigning a free port...`,
      )
    } else if (action === 'version-recreate') {
      log.warn(
        `Server version mismatch: running ${healthResult.body.version}, expected ${config.expectedVersion}. Restarting...`,
      )
      await removeOurs()
    } else if (action === 'recreate') {
      // Pull first so a failed pull never leaves us without a server.
      if (await ensureImage(config, log, true)) {
        pulled = true
        log.info('Recreating container (restart requested)...')
        await removeOurs()
      } else {
        log.warn('Restart aborted: image unavailable, keeping the running server')
        return healthyPort
      }
    } else if (action === 'warn-cannot-restart') {
      log.warn('Restart cannot replace this server: it is not the managed Docker container')
      return healthyPort
    } else {
      // Never recreate a healthy shared server on a config difference: other
      // sessions are using it.
      if (action === 'warn-redact') {
        log.warn(
          'Redaction patterns config differs from the running server; run /observe restart to apply',
        )
      }
      log.info(`Server already running on port ${healthyPort}`)
      return healthyPort
    }
  }

  // Ensure the local data dir has been created
  initLocalDataDirs(config)

  // Check existing container state
  let state = await getContainerState(config)

  const redactAction = decideRedactAction({
    serverHealthy: false,
    containerState: state ? (state.running ? 'running' : 'stopped') : null,
    actualLabel: state?.redactLabel,
    desiredLabel: redactLabel,
  })
  const restartRequested = !!opts.recreate && config.runtime === 'docker'
  if (state && (redactAction === 'recreate' || restartRequested)) {
    if (await ensureImage(config, log, true)) {
      pulled = true
      log.warn(
        restartRequested
          ? 'Recreating container (restart requested)...'
          : 'Redaction patterns config changed. Recreating container...',
      )
      await removeOurs()
      state = null
    } else {
      log.warn('Recreate skipped: image unavailable, keeping the existing container')
    }
  }

  if (state) {
    if (state.running) {
      // Container is running — re-check health in case it came up between our first check and now
      const recheck = await getJson(`${config.apiBaseUrl}/health`)
      if (recheck.status === 200 && recheck.body?.ok) {
        const port = new URL(config.apiBaseUrl).port || '4981'
        log.info(`Server started by another process on port ${port}`)
        return port
      }
      // Running but not healthy — remove and do a fresh start
      log.warn('Container is running but unhealthy, restarting...')
      await removeOurs()
    } else if (state.versionMatch) {
      // Stopped container with correct version — fast restart
      log.info(`Restarting stopped container (v${state.labelVersion})...`)
      const startResult = await run('docker', ['start', config.containerName])
      if (startResult.ok) {
        const port = config.serverPort
        saveServerPortFile(config, port)
        return await waitForHealth(config, port, log)
      }
      // docker start failed — fall through to fresh start
      log.warn(`Failed to restart container: ${startResult.stderr}`)
      await removeOurs()
    } else {
      // Stopped container with wrong version — remove for upgrade
      log.info(`Upgrading container from v${state.labelVersion} to v${config.expectedVersion}...`)
      await removeOurs()
    }
  }

  // -- Fresh start: pull + run ------------------------------------

  // Pull image (skipped in test harness when AGENTS_OBSERVE_TEST_SKIP_PULL=1)
  if (!pulled && !(await ensureImage(config, log, false))) return failStart()

  // Build docker run args from centralized server env
  const serverEnv = getServerEnv(config)
  const containerPort = serverEnv.AGENTS_OBSERVE_SERVER_PORT
  const preferredPort = config.serverPort

  function dockerRunArgs(portMapping) {
    return buildDockerRunArgs({ config, serverEnv, portMapping, redact, redactLabel })
  }

  // Try preferred port, fall back to auto-assign
  let runResult = await run(
    'docker',
    dockerRunArgs(buildPortMapping(config.serverBindHost, preferredPort, containerPort)),
  )
  let actualPort = preferredPort

  if (!runResult.ok && runResult.stderr.includes('port is already allocated')) {
    log.warn(`Port ${preferredPort} is in use, auto-assigning a free port...`)

    runResult = await run(
      'docker',
      dockerRunArgs(buildPortMapping(config.serverBindHost, 0, containerPort)),
    )

    if (!runResult.ok) {
      log.error(`Failed to start container: ${runResult.stderr}`)
      return failStart()
    }

    const portResult = await run('docker', ['port', config.containerName, containerPort])
    if (portResult.ok) {
      const match = portResult.stdout.match(/:(\d+)$/)
      if (match) actualPort = match[1]
    }
  } else if (!runResult.ok) {
    log.error(`Failed to start container: ${runResult.stderr}`)
    return failStart()
  }

  // Save port for hooks to discover
  saveServerPortFile(config, actualPort)

  return await waitForHealth(config, actualPort, log)
}

/**
 * Poll the health endpoint until the server is ready or we give up.
 * Returns the port on success, null on timeout.
 */
async function waitForHealth(config, port, log) {
  const apiUrl = `http://127.0.0.1:${port}/api`
  log.info('Waiting for server to start...')
  for (let i = 0; i < 15; i++) {
    const h = await getJson(`${apiUrl}/health`)
    if (h.status === 200 && h.body?.ok) {
      log.info('Server started successfully')
      return port
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  log.error('Server failed to start within 15 seconds')
  log.error(`Check: docker logs ${config.containerName}`)
  return null
}

/**
 * Stops the Docker container and cleans up the port file.
 * Container is stopped but NOT removed — it can be fast-restarted
 * on next startServer call if the version hasn't changed.
 */
export async function stopServer(config, log = console) {
  log.info('Stopping server...')
  if (await isOurContainer(config)) {
    await run('docker', ['stop', config.containerName])
  } else {
    const exists = await run('docker', ['inspect', config.containerName])
    if (exists.ok) {
      log.warn(
        `Container "${config.containerName}" is not managed by ${config.dockerLabel} — skipping stop`,
      )
    }
  }
  removeServerPortFile(config)
}
