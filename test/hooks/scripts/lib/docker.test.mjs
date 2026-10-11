// test/hooks/scripts/lib/docker.test.mjs
import { describe, it, expect } from 'vitest'
import {
  buildPortMapping,
  buildTranscriptMounts,
  buildDataMount,
  buildRedactPatternsArgs,
  buildDockerRunArgs,
  redactLabelValue,
  decideRedactAction,
  decideHealthyAction,
} from '../../../../hooks/scripts/lib/docker.mjs'

describe('buildRedactPatternsArgs', () => {
  const file = () => ({ isFile: () => true })
  const dir = () => ({ isFile: () => false })
  const missing = () => {
    throw new Error('ENOENT')
  }

  it('returns nothing when unset', () => {
    expect(buildRedactPatternsArgs({ hostPath: '' }, missing)).toEqual({
      args: [],
      warning: null,
    })
  })

  it('mounts the file read-only and sets the container env', () => {
    const { args, warning } = buildRedactPatternsArgs({ hostPath: '/h/p.json' }, file)
    expect(warning).toBeNull()
    expect(args).toEqual([
      '-v',
      '/h/p.json:/app/redact-patterns.json:ro',
      '-e',
      'AGENTS_OBSERVE_REDACT_PATTERNS_PATH=/app/redact-patterns.json',
    ])
  })

  it('adds the shared SELinux relabel option when requested', () => {
    const { args } = buildRedactPatternsArgs({ hostPath: '/h/p.json', relabel: true }, file)
    expect(args[1]).toBe('/h/p.json:/app/redact-patterns.json:ro,z')
  })

  it('warns and skips when the file is missing', () => {
    const { args, warning } = buildRedactPatternsArgs({ hostPath: '/h/none.json' }, missing)
    expect(args).toEqual([])
    expect(warning).toContain('/h/none.json')
  })

  it('rejects a directory', () => {
    const { args, warning } = buildRedactPatternsArgs({ hostPath: '/h/dir' }, dir)
    expect(args).toEqual([])
    expect(warning).toContain('regular file')
  })

  it('builds the mount for a Windows-style host path', () => {
    const win = 'C:\\Users\\x\\p.json'
    const { args } = buildRedactPatternsArgs({ hostPath: win }, file)
    expect(args[0]).toBe('-v')
    expect(args[1]).toBe(`${win}:/app/redact-patterns.json:ro`)
  })
})

describe('redactLabelValue', () => {
  it('is empty when unset or invalid', () => {
    expect(redactLabelValue('', true)).toBe('')
    expect(redactLabelValue('/h/p.json', false)).toBe('')
  })

  it('is a stable hash that does not expose the path', () => {
    const a = redactLabelValue('/h/p.json', true)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).toBe(redactLabelValue('/h/p.json', true))
    expect(a).not.toBe(redactLabelValue('/h/q.json', true))
    expect(a).not.toContain('p.json')
  })
})

describe('decideRedactAction', () => {
  const h = redactLabelValue('/h/p.json', true)
  const d = (o) => decideRedactAction({ serverHealthy: false, ...o })

  it('does nothing when there is no managed container', () => {
    expect(d({ containerState: null, actualLabel: h, desiredLabel: '' })).toBe('none')
  })

  it('does nothing for a missing label with the variable unset', () => {
    expect(d({ containerState: 'stopped', actualLabel: undefined, desiredLabel: '' })).toBe('none')
    expect(d({ containerState: 'running', actualLabel: '', desiredLabel: '' })).toBe('none')
  })

  it('does nothing when the labels are the same', () => {
    expect(d({ containerState: 'stopped', actualLabel: h, desiredLabel: h })).toBe('none')
    expect(
      d({ serverHealthy: true, containerState: 'running', actualLabel: h, desiredLabel: h }),
    ).toBe('none')
  })

  it('warns, never recreates, a healthy running server with a different label', () => {
    for (const desiredLabel of [h, '']) {
      const actualLabel = desiredLabel ? '' : 'abcd'
      expect(d({ serverHealthy: true, containerState: 'running', actualLabel, desiredLabel })).toBe(
        'warn',
      )
    }
  })

  it('recreates a stopped container with a different label', () => {
    expect(d({ containerState: 'stopped', actualLabel: '', desiredLabel: h })).toBe('recreate')
    expect(d({ containerState: 'stopped', actualLabel: h, desiredLabel: '' })).toBe('recreate')
  })

  it('leaves a running but not healthy container to the unhealthy path (none)', () => {
    expect(d({ containerState: 'running', actualLabel: '', desiredLabel: h })).toBe('none')
  })

  it('does nothing when another server is healthy and our container is stopped', () => {
    expect(
      d({ serverHealthy: true, containerState: 'stopped', actualLabel: '', desiredLabel: h }),
    ).toBe('none')
  })

  it('invalid or missing file gives desired empty, so a running labelled server only warns', () => {
    const missing = () => {
      throw new Error('ENOENT')
    }
    const redact = buildRedactPatternsArgs({ hostPath: '/h/p.json' }, missing)
    const desiredLabel = redactLabelValue('/h/p.json', redact.args.length > 0)
    expect(desiredLabel).toBe('')
    expect(
      d({ serverHealthy: true, containerState: 'running', actualLabel: h, desiredLabel }),
    ).toBe('warn')
  })
})

describe('decideHealthyAction', () => {
  const base = {
    idMatch: true,
    versionMatch: true,
    recreate: false,
    runtime: 'docker',
    ownRunningLabel: '',
    desiredLabel: '',
  }
  const d = (o) => decideHealthyAction({ ...base, ...o })

  it('returns the port by default and never recreates without a restart request', () => {
    expect(d({})).toBe('return-port')
    for (const ownRunningLabel of [null, '', 'abcd']) {
      for (const desiredLabel of ['', 'abcd', 'ef01']) {
        for (const runtime of ['docker', 'local', 'dev']) {
          expect(d({ ownRunningLabel, desiredLabel, runtime })).not.toBe('recreate')
        }
      }
    }
  })

  it('warns about a differing redact config without recreating', () => {
    expect(d({ ownRunningLabel: '', desiredLabel: 'abcd' })).toBe('warn-redact')
  })

  it('does not warn about redact config when the server is not our container', () => {
    expect(d({ ownRunningLabel: null, desiredLabel: 'abcd' })).toBe('return-port')
  })

  it('restart in local or dev runtime cannot replace the server', () => {
    expect(d({ recreate: true, runtime: 'local' })).toBe('warn-cannot-restart')
    expect(d({ recreate: true, runtime: 'dev' })).toBe('warn-cannot-restart')
  })

  it('restart when our container is not the running server cannot replace it', () => {
    expect(d({ recreate: true, ownRunningLabel: null })).toBe('warn-cannot-restart')
  })

  it('restart with our own running container in docker runtime recreates', () => {
    expect(d({ recreate: true })).toBe('recreate')
  })

  it('keeps the version mismatch and other-service behaviour', () => {
    expect(d({ versionMatch: false })).toBe('version-recreate')
    expect(d({ versionMatch: false, recreate: true, runtime: 'local' })).toBe('version-recreate')
    expect(d({ idMatch: false })).toBe('other-service')
    expect(d({ idMatch: false, recreate: true })).toBe('other-service')
  })
})

describe('buildDockerRunArgs', () => {
  const config = {
    containerName: 'agents-observe',
    dockerLabel: 'simple10-agents-observe.managed',
    expectedVersion: '1.2.3',
    dockerImage: 'img:1',
    dataDir: '/d/data',
    selinuxRelabel: false,
    transcriptStatsEnabled: true,
    transcriptClaudeHost: '/h/.claude/projects',
    transcriptCodexHost: '/h/.codex/sessions',
  }
  const serverEnv = { AGENTS_OBSERVE_SERVER_PORT: '4981', A: 'b' }
  const portMapping = '127.0.0.1:4981:4981'
  const exists = () => true
  const none = { args: [], warning: null }
  const valid = buildRedactPatternsArgs({ hostPath: '/h/p.json' }, () => ({ isFile: () => true }))
  const baseArgv = (...extra) => [
    'run',
    '-d',
    '--name',
    'agents-observe',
    '--label',
    'simple10-agents-observe.managed=1.2.3',
    '--label',
    `agents-observe.redact=${extra[0] || ''}`,
    '-p',
    '127.0.0.1:4981:4981',
    '-e',
    'AGENTS_OBSERVE_SERVER_PORT=4981',
    '-e',
    'A=b',
    '-v',
    '/d/data:/data',
    '-v',
    '/h/.claude/projects:/host/.claude/projects:ro',
    '-v',
    '/h/.codex/sessions:/host/.codex/sessions:ro',
  ]

  it('builds the full argv without a redact file', () => {
    const argv = buildDockerRunArgs(
      { config, serverEnv, portMapping, redact: none, redactLabel: '' },
      exists,
    )
    expect(argv).toEqual([...baseArgv(), 'img:1'])
  })

  it('adds exactly one read-only redact mount and env when valid, nothing else', () => {
    const label = redactLabelValue('/h/p.json', true)
    const argv = buildDockerRunArgs(
      { config, serverEnv, portMapping, redact: valid, redactLabel: label },
      exists,
    )
    expect(argv).toEqual([
      ...baseArgv(label),
      '-v',
      '/h/p.json:/app/redact-patterns.json:ro',
      '-e',
      'AGENTS_OBSERVE_REDACT_PATTERNS_PATH=/app/redact-patterns.json',
      'img:1',
    ])
    const ps = argv.flatMap((a, i) => (argv[i - 1] === '-p' ? [a] : []))
    expect(ps).toEqual(['127.0.0.1:4981:4981'])
    expect(argv.filter((a) => a === '-p')).toHaveLength(1)
    const redactMounts = argv.filter((a) => a.includes('redact-patterns.json:'))
    expect(redactMounts).toHaveLength(1)
    expect(redactMounts[0].endsWith(':ro')).toBe(true)
    expect(argv.filter((a) => a === '-v')).toHaveLength(4)
  })

  it('omits the redact env and mount for a missing file or a directory', () => {
    for (const stat of [
      () => {
        throw new Error('ENOENT')
      },
      () => ({ isFile: () => false }),
    ]) {
      const redact = buildRedactPatternsArgs({ hostPath: '/h/x' }, stat)
      const argv = buildDockerRunArgs(
        { config, serverEnv, portMapping, redact, redactLabel: '' },
        exists,
      )
      expect(argv).toEqual([...baseArgv(), 'img:1'])
      expect(argv.join(' ')).not.toContain('REDACT_PATTERNS')
    }
  })
})

describe('buildPortMapping (issue #22)', () => {
  it('prefixes the loopback bind host by default', () => {
    expect(buildPortMapping('127.0.0.1', 4981, 4981)).toBe('127.0.0.1:4981:4981')
  })

  it('supports auto-assign (host port 0) while keeping the loopback prefix', () => {
    expect(buildPortMapping('127.0.0.1', 0, 4981)).toBe('127.0.0.1:0:4981')
  })

  it('allows binding all interfaces for LAN access', () => {
    expect(buildPortMapping('0.0.0.0', 4981, 4981)).toBe('0.0.0.0:4981:4981')
  })

  it('omits the host prefix when bind host is empty (docker default)', () => {
    expect(buildPortMapping('', 4981, 4981)).toBe('4981:4981')
  })
})

describe('buildTranscriptMounts (issue #21)', () => {
  const alwaysExists = () => true
  const neverExists = () => false

  it('does NOT drop a Windows host path with a drive-letter colon', () => {
    // Regression: the old filter split the mount on ':' and mistook the
    // drive letter ("C") for the source, dropping both mounts on Windows.
    const mounts = buildTranscriptMounts(
      { claudeHost: 'C:\\Users\\me\\.claude\\projects', codexHost: '', enabled: true },
      alwaysExists,
    )
    expect(mounts).toEqual(['-v', 'C:\\Users\\me\\.claude\\projects:/host/.claude/projects:ro'])
  })

  it('mounts both agent classes on POSIX', () => {
    const mounts = buildTranscriptMounts(
      {
        claudeHost: '/home/me/.claude/projects',
        codexHost: '/home/me/.codex/sessions',
        enabled: true,
      },
      alwaysExists,
    )
    expect(mounts).toEqual([
      '-v',
      '/home/me/.claude/projects:/host/.claude/projects:ro',
      '-v',
      '/home/me/.codex/sessions:/host/.codex/sessions:ro',
    ])
  })

  it('skips a host path that does not exist', () => {
    const mounts = buildTranscriptMounts(
      {
        claudeHost: '/home/me/.claude/projects',
        codexHost: '/home/me/.codex/sessions',
        enabled: true,
      },
      (p) => p.includes('.claude'),
    )
    expect(mounts).toEqual(['-v', '/home/me/.claude/projects:/host/.claude/projects:ro'])
  })

  it('returns nothing when transcript stats are disabled', () => {
    expect(
      buildTranscriptMounts(
        {
          claudeHost: '/home/me/.claude/projects',
          codexHost: '/home/me/.codex/sessions',
          enabled: false,
        },
        alwaysExists,
      ),
    ).toEqual([])
  })

  it('returns nothing when no host path exists', () => {
    expect(
      buildTranscriptMounts(
        {
          claudeHost: '/home/me/.claude/projects',
          codexHost: '/home/me/.codex/sessions',
          enabled: true,
        },
        neverExists,
      ),
    ).toEqual([])
  })

  it('appends the shared SELinux relabel option (,z) when relabel is set (issue #20)', () => {
    const mounts = buildTranscriptMounts(
      {
        claudeHost: '/home/me/.claude/projects',
        codexHost: '/home/me/.codex/sessions',
        enabled: true,
        relabel: true,
      },
      alwaysExists,
    )
    expect(mounts).toEqual([
      '-v',
      '/home/me/.claude/projects:/host/.claude/projects:ro,z',
      '-v',
      '/home/me/.codex/sessions:/host/.codex/sessions:ro,z',
    ])
  })
})

describe('buildDataMount (issue #20)', () => {
  it('mounts the data dir at /data without a relabel option by default', () => {
    expect(buildDataMount('/home/me/.agents-observe/data')).toBe(
      '/home/me/.agents-observe/data:/data',
    )
  })

  it('appends the SELinux relabel option (:z) when relabel is set', () => {
    expect(buildDataMount('/home/me/.agents-observe/data', true)).toBe(
      '/home/me/.agents-observe/data:/data:z',
    )
  })

  it('does not relabel when relabel is false', () => {
    expect(buildDataMount('/home/me/.agents-observe/data', false)).toBe(
      '/home/me/.agents-observe/data:/data',
    )
  })
})
