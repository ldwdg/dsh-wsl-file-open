---
name: dsh-wsl-file-open
description: "Use when DSH web (DeepSeek Harness) on WSL cannot hand files or folders to the Windows desktop: clicking a deliverable card shows 打开失败 / Could not open, the explorer opening lands on Documents or does not select the file, the 'Open with…' menu says 无法获取应用列表 / Could not load applications, or the session-header 'Open In…' button fails. Installs/repairs a profile plugin that fixes the four native-open integrations."
version: 1.0.0
metadata:
  tags: [dsh, wsl, explorer, reveal, native-open, profile-patch, file-open]
  tested-with: dsh 0.2.0-rc.2
---

# dsh-wsl-file-open

DSH web on WSL2 fails to hand files and folders to the Windows desktop. This skill
diagnoses and fixes the four entry points.

## Symptoms → cause

| Symptom | Cause |
|---|---|
| `打开失败` / `Could not open` on a card | service PATH lacks `/mnt/c/Windows/**`; bare `powershell.exe` spawn is ENOENT |
| Explorer opens `Documents` (or the profile) instead of the file | `explorer.exe /select` rejects UNC / CJK paths |
| Folder opens but the file is not selected | same; upstream hands Explorer a percent-encoded `file://` URI |
| `无法获取应用列表` / `Could not load applications` | the Linux application query spawns bare `gio` and needs desktop MIME data that WSL lacks |
| Picking an app hangs or does nothing | Shell COM `IHandler::Invoke(IDataObject)` drops the app's registered arguments |
| `Open In…` button fails | upstream declares its file manager for Linux as `xdg-open` only |

## Install (fast path)

```bash
git clone https://github.com/ldwdg/dsh-wsl-file-open.git
cd dsh-wsl-file-open
bash install.sh --with-xdg-open      # drop --with-xdg-open if you already have one
systemctl --user restart dsh-web     # REQUIRED: the running service does not hot-reload the patch
```

Hard-refresh the browser afterwards. Buttons may be grey for a moment on first use
(desktop warm-up), not a failure.

## What it installs

```
~/.dsh/profiles/<profile>/wsl-file-open/    index.js  impl.mjs  program.ps1  package.json
~/.dsh/profiles/<profile>/cordis.patch.yml  one marked insert block
~/.dsh/skills/dsh-wsl-file-open/SKILL.md
~/.local/bin/xdg-open                       optional, for the "Open In…" button
```

The repository is also a valid DSH bundle: `package.json` declares
`dsh.bundle.patch` → `cordis.patch.yml`, which inserts the package by name. With `pnpm`
available, install it the standard way (`dsh plugin --profile web add <spec>`, then add
`dsh-wsl-file-open` to `dsh.profile.bundles`); the vendored installer above is the
zero-dependency path.

The plugin replaces four `sessionController` host integrations
(`fileApplications`, `openFileApplication`, `openPath`, `revealPath`). It does not patch
DSH packages. The vendored manifest must be **named and versioned** (`type: module` included). DSH's
package inventory accepts that, silently excludes a manifest without `name`, and fails
every model request with `REQUEST_EXTENSION` for a `name` without `version`.

## Verify

```bash
bash scripts/verify.sh
# then click a card: the folder must open with the file selected
tail -n 20 /tmp/dsh-wsl-file-open.log    # which branch ran, which registered command was used
```

Host-side checks are in `docs/verification.md`.

## Troubleshooting

| Check | Meaning |
|---|---|
| `ps -o lstart= -p <MainPID>` older than your last edit | the running service never loaded the change — restart it |
| log has `fileApplications ok -> N apps` | the application list works |
| log has `registered command ... key=...` | which registry command was used for the chosen app |
| log has no `fileApplications called` | the plugin did not load; check the patch block and the restart |
| button grey then recovers | normal warm-up (`verifyDesktopPath` + `wslpath`) |

Editing rules:

- `program.ps1` is read from disk on every call — edit it freely.
- `impl.mjs` / `index.js` are cached by module URL. After editing them, **rename the
  entry and update the patch block**, or restart the service.
- Do not wrap `openWorkspacePath`: in DSH 0.2 the controller invokes the four fields
  itself, so replacing the fields preserves its path verification and error mapping.

## Compatibility

- Tested against DSH `0.2.0-rc.2`. The four fields are treated as replaceable host
  integrations (declared in the SDK's `SessionControllerInternals`), not a public
  extension point. The plugin checks `typeof … === 'function'` per field and leaves a
  missing one alone, degrading to upstream behaviour.
- Older DSH (0.1.x) exposed a single `openWorkspacePath` seam instead; this plugin does
  not target it.
- Windows must be mounted at `/mnt/c` unless `DSH_WSL_FILE_OPEN_WINDOWS_ROOT` overrides it.

## Remove

```bash
bash uninstall.sh --with-xdg-open
systemctl --user restart dsh-web
```

Root causes with code references: `docs/upstream-analysis.md`.
