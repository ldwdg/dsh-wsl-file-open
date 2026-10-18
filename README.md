# dsh-wsl-file-open

Fix **"open in File Explorer"**, **"open with…"**, and the **"Open In…"** button for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web when the
host runs inside **WSL2**.

On a WSL deployment these gestures fail in four different ways. This repository ships a
small profile plugin plus a skill that fixes all four without patching DSH itself.

## What it fixes

| UI gesture | Before | After |
|---|---|---|
| Card menu → *Show in File Explorer* | Opens `Documents` (or the user profile) instead of the file's folder; CJK file names are never selected | Opens the containing folder **and selects the file** |
| Card menu → *Open* (default app) | `打开失败` / `Could not open` | Opens with the registered default application |
| Card menu → *Open with…* | `Could not load applications` | Lists the real Windows handlers (icons included) |
| Session header → *Open In…* | `打开失败` (only `xdg-open` is offered) | Opens the workspace folder in Windows Explorer |

## Why it breaks (short version)

1. **Service PATH** — `dsh-web` started by systemd inherits a PATH without
   `/mnt/c/Windows/**`, so bare `explorer.exe` / `powershell.exe` spawns are `ENOENT`.
2. **`explorer.exe /select` cannot select a UNC or CJK path** — upstream builds a
   percent-encoded `file://` URI; non-ASCII names are silently not selected.
3. **The application list shells out to a bare `gio`** on the Linux branch, and this
   host has no desktop MIME database → the query throws.
4. **Picking an application via Shell COM loses the app's registered arguments** — apps
   that need a flag (e.g. Navicat's `-uri`) hang or do nothing.

Details and code references: [docs/upstream-analysis.md](docs/upstream-analysis.md).

## How it works

```
~/.dsh/profiles/<profile>/cordis.patch.yml   ← insert one loader entry
        │
        ▼
wsl-file-open/index.js                       ← package main (re-exports)
        │
        ▼
wsl-file-open/impl.mjs                       ← overrides four sessionController integrations
    ├─ fileApplications     → absolute-path runner around dsh-native-command
    ├─ openFileApplication  → the app's registered command (registry), not Shell-COM invoke
    ├─ openPath             → absolute-path runner
    └─ revealPath           → Shell namespace + SelectItem (program.ps1)
        │
        ▼
wsl-file-open/program.ps1                    ← read from disk on every call (editable live)
```

The plugin is a normal DSH package: `package.json` declares `main`/`exports`, and
`cordis.patch.yml` declares a **bundle patch** so the package can also be installed the
standard way (see *Alternative: install as a bundle*). The vendored installer mounts it
through DSH's documented **profile patch layer**; neither path modifies any DSH package. It replaces `sessionController` fields that DSH treats as
replaceable host integrations, so the controller keeps its own path verification, error
mapping, and wire schema.

## Requirements

- WSL2 with Windows mounted at `/mnt/c` (override with `DSH_WSL_FILE_OPEN_WINDOWS_ROOT`)
- DSH **0.2.x** (tested on `0.2.0-rc.2`), `dsh web` profile
- Windows PowerShell at the standard location, `explorer.exe` present

## Install

```bash
git clone https://github.com/ldwdg/dsh-wsl-file-open.git
cd dsh-wsl-file-open
bash install.sh
```

Optional flags:

```bash
bash install.sh --with-xdg-open     # also install ~/.local/bin/xdg-open (fixes "Open In…")
bash install.sh --force-xdg-open    # overwrite an existing ~/.local/bin/xdg-open (backs it up)
```

The installer is idempotent: it backs up `cordis.patch.yml`, copies `lib/` into the
profile, writes a named+versioned `package.json` beside it, adds a marked insert block only
when absent, and installs the skill to `~/.dsh/skills/dsh-wsl-file-open/`.

### Alternative: install as a bundle

The repository is also a valid DSH bundle (`package.json` → `dsh.bundle.patch`). If you
have `pnpm` on PATH:

```bash
dsh plugin --profile web add github:ldwdg/dsh-wsl-file-open   # or a git/file spec
# then add "dsh-wsl-file-open" to dsh.profile.bundles in ~/.dsh/profiles/web/package.json
systemctl --user restart dsh-web
```

This path needs no vendored copy; the bundle patch inserts the package by name and pnpm
also installs the plugin's `@deepseek-ai/dsh-native-command` dependency. The default
installer remains dependency-free (it works without pnpm or a package registry) because the
vendored copy resolves that library from the DSH installation closure.

### Restart is required

DSH 0.2 does **not** hot-reload the profile patch into a running service:

```bash
systemctl --user restart dsh-web     # or however you launch `dsh web`
```

Then hard-refresh the browser. Buttons may stay grey for a moment on first use — that is
the desktop warm-up, not a failure.

## Verify

```bash
bash scripts/verify.sh              # host metadata + application list
```

Or manually (see [docs/verification.md](docs/verification.md)):

```bash
TOKEN=$(journalctl --user -u dsh-web --since "10 min ago" | grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)
curl -c /tmp/c.txt -b /tmp/c.txt -L -o /dev/null "http://127.0.0.1:30808/?token=$TOKEN"
curl -b /tmp/c.txt http://127.0.0.1:30808/api/present.host     # {"available":true,...}
curl -b /tmp/c.txt http://127.0.0.1:30808/open-in-app/apps     # {"apps":[...]}
```

Then click a card and confirm the file is **selected** in Explorer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DSH_WSL_FILE_OPEN_WINDOWS_ROOT` | `/mnt/c` | Windows mount root |
| `DSH_WSL_FILE_OPEN_LOG` | `/tmp/dsh-wsl-file-open.log` | Diagnostic log; `off` disables |
| `DSH_WSL_FILE_OPEN_DEBUG` | unset | `1` adds phase timings |

The diagnostic log records which branch ran and which registered command was used — the
fastest way to debug a per-application quirk.

## Uninstall

```bash
bash uninstall.sh                  # removes plugin, skill, and the marked patch block
bash uninstall.sh --with-xdg-open  # also restores/removes the xdg-open shim
systemctl --user restart dsh-web
```

## Known limitations

- **"Open with…" is best-effort per application.** The plugin runs the application's
  registered command. Applications that do not accept a file argument on the command line
  launch without opening the file. **Navicat Premium 17** is one: its registration is
  `"…\navicat.exe" "%1"`, yet `"%1"`, `-uri file:///…` and ShellExecuteEx with the
  application class all leave the file closed (verified). Use Explorer's right-click
  *Open with* for those applications.
- The application list only contains handlers Windows registers for the file extension;
  an application with no registration will not appear.

## Compatibility caveats

- The plugin relies on `sessionController` fields that DSH documents as **internal test
  seams** (`fileApplications`, `openFileApplication`, `openPath`, `revealPath`). They are
  ordinary instance properties today; a future DSH release may rename or privatise them.
  The plugin checks each field with `typeof … === 'function'` and simply leaves it alone
  when absent, so a change degrades to upstream behaviour instead of breaking DSH.
- `program.ps1` is re-read per call; `impl.mjs` / `index.js` are **cached by URL** — after
  editing them, rename the entry (and update the patch) or restart the service.
- Selecting a file launches a PowerShell process (≈3–6 s). Reveal is the slow path;
  default-open is faster.

## 中文速览

- **修什么**：WSL 上 DSH web 的「资源管理器显示（含选中）」「默认应用打开」「打开方式」「Open In…」四个入口。
- **装**：`bash install.sh`，然后 `systemctl --user restart dsh-web`，刷新页面。
- **卸载**：`bash uninstall.sh` 后重启。
- **排障**：看 `/tmp/dsh-wsl-file-open.log`；详细根因见 `docs/upstream-analysis.md`。
- **注意**：插件依赖 DSH 的内部接缝（非官方扩展点），缺失时自动降级；改 `impl.mjs` 需重启，改 `program.ps1` 立即生效。

## License

MIT — see [LICENSE](LICENSE).
