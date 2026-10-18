# Why upstream fails on WSL (0.2.0-rc.2)

This is a read-only analysis of the installed DSH packages. File paths refer to
`node_modules/@deepseek-ai/<package>/lib/index.js` inside the DSH installation.

## 1. The seam: `sessionController` host integrations

`@deepseek-ai/dsh-api-session-controller` declares four replaceable integrations
(`SessionControllerInternals`):

```ts
readonly openPath?: (path, signal) => Promise<void>
readonly revealPath?: (path, signal) => Promise<void>
readonly canOpenPath?: () => boolean
readonly fileApplications?: (path, signal) => Promise<NativeFileApplication[]>
readonly openFileApplication?: (path, application, signal) => Promise<void>
```

The constructor assigns defaults:

```js
this.fileApplications = internals.fileApplications ?? nativeFileApplications
this.openFileApplication = internals.openFileApplication ?? openNativeFileApplication
this.openPath = internals.openPath ?? openNativeAssociatedPath
this.revealPath = internals.revealPath ?? revealNativePath
```

`openWorkspacePath` dispatches on the request:

```js
if (request.action === 'reveal') await this.revealPath(path, signal)
else if (request.application !== undefined) await this.openFileApplication(path, request.application, signal)
else await this.openPath(path, signal)
```

and `workspacePathApplications` (the "Open with…" list) calls `this.fileApplications`.
Replacing the four fields therefore fixes every UI entry point while the controller keeps
its path verification, `RemoteError` mapping, and wire schema.

## 2. `@deepseek-ai/dsh-native-command`

### WSL detection and path translation

`isWsl()` returns true when `WSL_DISTRO_NAME`/`WSL_INTEROP` is set or `os.release()`
contains `microsoft`. `desktopTarget(path)` then translates the path with `wslpath -w`
and selects the **win32** branch.

### Bare executable names

Every Windows branch spawns a bare name:

```js
run('powershell.exe', ['-NoProfile', '-Command', `Invoke-Item -LiteralPath '…'`])
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath])
run('explorer.exe', ['/select,', target])
```

A `dsh web` started by a systemd user unit inherits a PATH such as
`/home/<user>/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
which has **no `/mnt/c/Windows/**`**. The spawn therefore fails with `ENOENT` and the
route answers 500; the UI shows "打开失败" / "Could not open". A `dsh web` started from a
login shell often works because WSL appends the Windows directories to PATH.

### Selecting a file in Explorer

`revealNativePath` builds `file://` + `wslpath -w` output and calls
`explorer.exe /select,<uri>`. Explorer accepts `/select` for drive-letter paths, but not
for a UNC location, and the percent-encoded URI loses non-ASCII names. Measured in one
folder, varying only the file name:

| file name | `file:///D:/…` + `/select,` | raw `D:\…` + `/select,` |
|---|---|---|
| `ascii-only.docx` | selected | selected |
| `space name.docx` | selected | **opens the wrong folder** |
| `纯中文名.docx` | **nothing selected** | selected |
| `区域 手册 v0.8 (final).docx` | **nothing selected** | **opens the wrong folder** |

Neither argument form is safe by itself; the Shell namespace
(`Shell.Application` → `NameSpace` → `Document.SelectItem`) is.

### Application list

`nativeFileApplications` → `queryFileApplications`:

- Windows: spawns bare `powershell.exe` with a generated `.ps1` that enumerates shell
  handlers through `SHAssocEnumHandlers` (`WINDOWS_ASSOCIATIONS` C#), then runs
  `ConvertTo-Json`.
- Linux: `linuxFileApplications` spawns bare `gio info -a standard::content-type <path>`
  and requires a `standard::content-type:` line. A WSL host without a desktop session
  returns no content type → `GIO did not identify the file content type` → the query
  throws → `workspacePathApplications` wraps it in `gateway/internal` → the UI shows
  "无法获取应用列表" / "Could not load applications".

### Opening with a chosen application

Windows uses `SHCreateItemFromParsingName` + `BindToHandler(IID_…, IDataObject)` +
`IHandler::Invoke(data)`. That invocation **drops the application's registered command
line arguments**. Applications that depend on a flag never receive it. Example measured
on this host:

```
HKCU\SOFTWARE\Classes\Navicat\shell\open\command
  = "…\navicat.exe" -uri "%1"
```

Invoking the handler through COM hangs; running the registered command opens the file
for applications that accept a file argument. It is necessary but not sufficient: Navicat
17 also ignores a command-line file argument (`"%1"`, `-uri file:///…`, and
ShellExecuteEx with the application class were all verified to leave the file closed), so
its only working integration is the shell handler, which blocks in a service context.
Per-application open is therefore best-effort.

## 3. `@deepseek-ai/dsh-host-open-in-app` (the "Open In…" button)

The catalog is a compile-time table:

```js
{ id: 'explorer',    platforms: { win32: spec({ kind: 'fixed', launch: { kind: 'shell-open' } }) } },
{ id: 'filemanager', platforms: { linux: spec(desktopCli('xdg-open')) } },
```

On WSL `os.platform()` is `linux`, so `GET /open-in-app/apps` returns only
`["filemanager"]`. Its launcher is `desktopCli('xdg-open')`, which requires
`canOpenNativePath` (true on WSL) and resolves `xdg-open` from PATH. The stock
`/usr/bin/xdg-open` fails without a desktop environment, so `POST /open-in-app/open`
answers 502 `launch-failed`.

Two more details:

- Routes are exact-path and `webServer.register` throws on duplicates, so a plugin cannot
  override them.
- `launchWatchMs` defaults to 1000 ms while a WSL handoff takes 1–3 s. Even when the
  folder does open, the route may report failure. Raise it in the profile patch:

```yaml
- id: open-in-app
  config:
    probeTimeoutMs: 10000
    iconTimeoutMs: 10000
    launchWatchMs: 15000
```

## 4. Profile patch layer and the package inventory

DSH's `dsh-plugin-package-inventory-deepseek` resolves the nearest `package.json` for
every active loose module before each model request:

- `name` + `version` → the entry contributes a package identity (what the installer
  writes for the vendored copy, and what the published package has);
- no `name` → identity `undefined`, entry silently excluded;
- `name` without `version` → throws `must declare non-empty name and version`, and every
  model request fails with `LlmError(REQUEST_EXTENSION)`.

A relative plugin therefore needs a **named, versioned** manifest (or an anonymous one).
The installer writes `{"name":"dsh-wsl-file-open","version":"…","private":true,
"type":"module"}` beside the copied `lib/` files.

## Observed reload behaviour

In the tested deployment (DSH 0.2.0-rc.2, systemd user unit), editing
`cordis.patch.yml` did **not** reach the running process: `touch` of the patch and of the
entry produced no reload, and a runtime marker in the plugin never fired until the
service was restarted. Treat **restart as required** after installing.
