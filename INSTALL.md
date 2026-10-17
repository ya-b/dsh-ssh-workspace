# Installing into a dsh profile

The plugin replaces the `execution-worlds` row of a profile bundle. Cordis
patch entries cannot rename a row, so the row is disabled and re-inserted with
the same id under this plugin's name.

## 1. Build the daemon archive

```bash
cd packages/daemon && pnpm run build      # writes lib/workspaced.js
cd ../realm && pnpm run archive           # writes dist/daemon.tar.gz (bundle + node-pty)
```

## 2. Install the plugin into the profile

```bash
dsh plugin --profile web add 'link:/path/to/dsh-ssh-workspace/packages/realm'
```

## 3. Patch the profile layer

Append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: execution-worlds
  disabled: true
- insert:
    - id: execution-worlds
      name: '@dsh-ssh-workspace/realm'
      config:
        daemonDir: '~/.dsh-workspace'   # remote state directory; ~ expands remotely
        node: /usr/bin/node             # absolute remote node path (>= 20)
        install: true                   # ship the daemon archive on first use
```

Then verify the composition and restart:

```bash
dsh --profile web --dump-config | grep -A6 execution-worlds
```

## Settings

The re-inserted row shares the `execution-worlds` settings namespace, so the
existing Plugins page keeps working: `daemonDir`, `node`, `install`,
`reconnectBaseMs`, `reconnectMaxMs`, `controlDir`, `requestTimeoutMs`,
`maxFrameBytes`, `maxPending` are this plugin's fields. The helper-oriented
fields the page still shows (`helper`, `helperHash`, `launchKind`,
`bootstrapPath`, `bootstrapHash`, `leaseMs`) are accepted and ignored.

## Rollback

Remove the two patch entries above (the row reverts to the helper-backed
implementation) and `dsh plugin --profile web remove @dsh-ssh-workspace/realm`.
