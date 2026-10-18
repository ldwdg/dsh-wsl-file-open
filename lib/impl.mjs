// WSL native file-open shim for the dsh web profile — stable loader shell.
//
// What it fixes: on WSL, DSH web cannot hand a file or folder to the Windows
// desktop. The explorer reveal drops the selection (UNC + CJK names), the
// default open spawns a bare `powershell.exe` that the service PATH cannot
// resolve, the application list shells out to a bare `gio` with no desktop
// MIME data, and picking a concrete application through Shell COM loses the
// application's registered arguments.
//
// How it works: this module replaces four documented-as-internal
// `sessionController` integrations (`fileApplications`, `openFileApplication`,
// `openPath`, `revealPath`) so the controller keeps its own path verification,
// error mapping, and wire schema. Windows binaries are addressed by absolute
// path; the PowerShell program lives in ./program.ps1 and is re-read on every
// call, so it can be edited without restarting the service.
//
// Cache note: the cordis loader imports a relative entry through a plain
// `import(url)` with no cache-buster, so Node keeps the first module instance.
// Editing this file does NOT affect a running service; the entry must be
// renamed (or the service restarted) to pick it up.
//
import { execFile } from 'node:child_process'
import { nativeFileApplications, openNativeAssociatedPath, openNativeFileApplication } from '@deepseek-ai/dsh-native-command'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { release } from 'node:os'
import { isAbsolute, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Windows mount root; override when Windows is not mounted at /mnt/c. */
const WINDOWS_ROOT = process.env.DSH_WSL_FILE_OPEN_WINDOWS_ROOT ?? '/mnt/c'

/** Diagnostic log path; set DSH_WSL_FILE_OPEN_LOG=off to disable. */
const LOG_PATH = process.env.DSH_WSL_FILE_OPEN_LOG ?? '/tmp/dsh-wsl-file-open.log'

/** Verbose phase timings, opt-in: DSH_WSL_FILE_OPEN_DEBUG=1. */
const DEBUG = process.env.DSH_WSL_FILE_OPEN_DEBUG === '1'

const run = (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', signal, windowsHide: true }, (error) =>
      error === null ? resolve() : reject(error),
    )
  })

/**
 * Absolute path of the Explorer executable.
 *
 * A systemd-managed `dsh web` starts from `/etc/environment`'s PATH, which has
 * no `/mnt/c/Windows/**` entries, so spawning bare `explorer.exe` is an ENOENT
 * even though WSL interop is enabled. Upstream resolves the name through PATH
 * and fails here; this shim sidesteps that by using the mount path when it
 * exists, and still works when PATH does carry the Windows directories.
 */
const explorerExecutable = () => {
  for (const candidate of [`${WINDOWS_ROOT}/Windows/explorer.exe`, `${WINDOWS_ROOT}/Windows/System32/explorer.exe`]) {
    if (existsSync(candidate)) return candidate
  }
  return 'explorer.exe'
}

/** Path of the editable PowerShell program, next to this cached shell. */
const programPath = fileURLToPath(new URL('./program.ps1', import.meta.url))

/**
 * Read the PowerShell program from disk.
 *
 * Read per call, never cached: this is what makes a running service pick up a
 * shim fix without a restart or an entry rename. Editing a module file alone
 * cannot do that (see the header).
 *
 * @returns the program text, or undefined when the file is missing.
 */
const readProgram = () => {
  try {
    return readFileSync(programPath, 'utf8')
  } catch {
    return undefined
  }
}

/** Absolute path of Windows PowerShell, resolved the same way as Explorer. */
const powershellExecutable = () => {
  for (const candidate of [
    `${WINDOWS_ROOT}/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
    `${WINDOWS_ROOT}/Windows/System32/WindowsPowerShell/v1.0/pwsh.exe`,
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/**
 * PowerShell program that opens a folder and selects one file inside it.
 *
 * Windows Explorer cannot `/select` a UNC location (it falls back to the user
 * profile), so a `\\wsl.localhost\...` path needs the Shell namespace instead:
 * `Shell.Application` + `Document.SelectItem` is the mechanism Explorer's own
 * "open containing folder" uses, and it works for UNC.
 *
 * The folder and file name are **base64 UTF-8 payloads**, not parameters and
 * not environment variables, because neither survives this call path:
 *
 * - `execFile` on Linux does not apply Windows quoting, so anything after
 *   `-Command` is split by Windows and never binds to a `param()` block
 *   (measured: `$Dir` empty, the arguments echoed as bare output lines).
 * - WSL interop forwards only `WSLENV`-listed variables to Windows, so custom
 *   environment variables arrive empty.
 *
 * Base64 keeps the whole command line ASCII, and the payload is decoded inside
 * PowerShell, so non-ASCII file names (CJK) survive byte-exactly. The script
 * itself is plain ASCII. Exit codes: 2 no namespace, 3 no window, 4 file not
 * listed, 5 selection did not take.
 *
 * @param windowsDir - containing folder as a Windows path.
 * @param name - file name within that folder.
 * @returns the PowerShell program text.
 */
const psSelectProgram = (windowsDir, name) => {
  const dir64 = Buffer.from(windowsDir, 'utf8').toString('base64')
  const name64 = Buffer.from(name, 'utf8').toString('base64')
  return `function D([string]$b){[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))}; $Dir=D '${dir64}'; $Name=D '${name64}'; $shell = New-Object -ComObject Shell.Application; if (-not $shell.NameSpace($Dir)) { exit 2 }; Start-Process explorer.exe -ArgumentList $Dir; $w = $null; foreach ($n in 1..40) { Start-Sleep -Milliseconds 250; $fresh = New-Object -ComObject Shell.Application; foreach ($cand in @($fresh.Windows())) { if ($cand.Document.Folder.Self.Path -eq $Dir) { $w = $cand; break } }; if ($w) { break } }; if (-not $w) { exit 3 }; $folder = $shell.NameSpace($Dir); $target = $null; foreach ($i in $folder.Items()) { if ($i.Name -eq $Name) { $target = $i } }; if (-not $target) { exit 4 }; $w.Visible = $true; $w.Document.SelectItem($target, 29); $w.Document.FocusedItem | Out-Null; if ($w.Document.FocusedItem.Name -ne $Name) { exit 5 }`
}

/**
 * WSL detection, equivalent to `dsh-native-command`'s own `isWsl()`.
 *
 * The kernel release (`os.release()`, i.e. /proc/sys/kernel/osrelease) is the
 * load-bearing marker: a systemd-managed `dsh web` inherits neither
 * WSL_DISTRO_NAME/WSL_INTEROP nor a `process.release.name` containing
 * "microsoft" (Node reports "node"), so env-only detection silently disables
 * this shim in exactly the deployment it exists for. Verified on the live
 * service: /proc/<pid>/environ has no WSL_* entries.
 */
const isWsl = () =>
  Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ||
  (process.platform === 'linux' && release().toLowerCase().includes('microsoft'))

/**
 * Run Explorer and treat its "handed off" statuses as success.
 *
 * `explorer.exe` exits 1 even when it did open the requested location, so an
 * exit status of 1 (or WSL interop's unsigned rendering of it, 0xFFFFFFFF) is
 * success. A spawn failure such as ENOENT, or any other status, still throws.
 *
 * @param args - Explorer argv.
 * @param signal - caller lifetime; abort terminates the child.
 */
const runExplorer = async (args, signal) => {
  try {
    await run(explorerExecutable(), args, signal)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 1 || code === -1 || code === 4294967295) return
    throw error
  }
}

/**
 * Containing folder of a translated Windows path.
 *
 * This must use the Win32 variant: on Linux `path.dirname()` treats `\` as an
 * ordinary character, so a UNC path collapses to its last segment and
 * `dirname()` returns `"."` — which spawned `explorer.exe .` instead of the
 * folder. (Upstream avoids this by taking the dirname of the *POSIX* path.)
 *
 * @param windowsPath - absolute Windows path from `wslpath -w`.
 * @returns the containing folder in the same Windows form.
 */
const windowsDirname = (windowsPath) => {
  const parent = win32.dirname(windowsPath)
  return parent === '' || parent === '.' ? windowsPath : parent
}

/**
 * Executable map for the native helpers that still spawn bare names.
 *
 * `dsh-native-command`'s Windows branch runs `powershell.exe`, and its Linux
 * branch runs `gio`; neither resolves under the systemd-managed service (no
 * `/mnt/c/Windows/**` in PATH, and `gio` needs desktop integration it does not
 * have). Reusing the package's exported implementations with this runner keeps
 * their Shell-association C# and JSON shaping, and only fixes the spawn.
 */
const NATIVE_EXECUTABLES = () => ({
  'powershell.exe': `${WINDOWS_ROOT}/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
  'pwsh.exe': `${WINDOWS_ROOT}/Windows/System32/WindowsPowerShell/v1.0/pwsh.exe`,
  'explorer.exe': `${WINDOWS_ROOT}/Windows/explorer.exe`,
  gio: '/usr/bin/gio',
})

/** Resolve a bare executable name to the path this host actually holds. */
const resolveExecutablePath = (command) => {
  const candidate = NATIVE_EXECUTABLES()[command]
  return candidate !== undefined && existsSync(candidate) ? candidate : command
}

/**
 * Runner for the native application helpers, with absolute executables.
 * @param command - executable name the helper wants.
 * @param args - argv.
 * @param signal - caller lifetime.
 * @returns captured stdout/stderr on exit 0.
 */
const runWithAbsolutePaths = (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      resolveExecutablePath(command),
      args,
      { encoding: 'utf8', maxBuffer: 1 << 24, signal, windowsHide: true },
      (error, stdout, stderr) =>
        error === null ? resolve({ stdout, stderr }) : reject(Object.assign(error, { stdout, stderr })),
    )
  })

/**
 * Append one diagnostic line where it can be read from outside the service.
 *
 * `--dump-config` cannot show runtime state and the service does not forward
 * plugin logs to the journal, so a file is the only channel that answers
 * "did my override actually run inside the live process".
 */
const mark = (message) => {
  if (LOG_PATH === 'off') return
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

/** The native helpers call `signal.throwIfAborted()`, so never hand them undefined. */
const withSignal = (signal) => signal ?? new AbortController().signal

/** Upper bound on the Shell-namespace selection round trip. */
const SELECT_TIMEOUT_MS = 20000

/**
 * Open a folder in Explorer and select one file inside it.
 *
 * Needed for UNC paths, where `explorer.exe /select` silently opens the user
 * profile instead.
 *
 * @param windowsDir - containing folder as a Windows path.
 * @param name - file name within that folder.
 * @param signal - caller lifetime plus an internal timeout.
 */
async function runPowershellSelect(windowsDir, name, signal) {
  const timeout = AbortSignal.timeout(SELECT_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const template = readProgram() ?? psSelectProgram(windowsDir, name)
  const dir64 = Buffer.from(windowsDir, 'utf8').toString('base64')
  const name64 = Buffer.from(name, 'utf8').toString('base64')
  const program = template.replaceAll('__DIR64__', dir64).replaceAll('__NAME64__', name64)
  await run(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', program], combined)
}

/**
 * Open a file with a specific registered application, using the application's
 * own command line.
 *
 * Why not the host's Shell-COM path: `windowsFileApplications(path, app, …)`
 * invokes the handler through `IHandler::Invoke(IDataObject)`, which drops the
 * application's registered arguments. Measured on Navicat Premium 17, whose
 * registration is `"...\navicat.exe" -uri "%1"` — Navicat needs that `-uri`
 * form, so through COM it hangs while the Explorer context menu (which runs the
 * registered command) opens normally. Hardcoding per-app flags is not an
 * option, so read the registered command and run it with `%1` replaced.
 *
 * @param path - absolute Host path.
 * @param application - application id from `fileApplications` (an executable path).
 * @param signal - caller lifetime.
 * @returns true when a registered command was found and launched.
 */
async function openWithRegisteredCommand(path, application, signal) {
  if (typeof application !== 'string' || !/\.exe$/i.test(application)) return false
  const windowsPath = await toWindowsPath(path, signal)
  const file = windowsPath.replace(/'/g, "''")
  const exe = application.replace(/'/g, "''")
  const program = `$exe = '${exe}'
$file = '${file}'
$name = Split-Path $exe -Leaf
$ext = [IO.Path]::GetExtension($file).TrimStart('.')
$exact = New-Object System.Collections.Generic.List[string]
$related = New-Object System.Collections.Generic.List[string]
foreach ($root in @('HKCU:\\SOFTWARE\\Classes', 'HKLM:\\SOFTWARE\\Classes')) {
  $exact.Add((Join-Path $root ('Applications\\' + $name + '\\shell\\open\\command')))
  if ($ext) {
    $extKey = Join-Path $root ('.' + $ext)
    $exact.Add((Join-Path $extKey ($name + '\\shell\\open\\command')))
    foreach ($sub in @('OpenWithList', 'OpenWithProgids')) {
      $listKey = Join-Path $extKey $sub
      foreach ($entry in (Get-ChildItem $listKey -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName })) {
        $candidate = if ($sub -eq 'OpenWithList') { Join-Path $root ('Applications\\' + $entry + '\\shell\\open\\command') }
                     else { Join-Path $root ($entry + '\\shell\\open\\command') }
        if ($candidate) { $related.Add($candidate) }
      }
    }
  }
}
function Invoke-Command-Key([string] $key, [string] $file) {
  if (-not (Test-Path $key)) { return $false }
  $command = (Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)'
  if (-not $command) { return $false }
  if ($command -notlike ('*' + $name + '*')) { return $false }
  # Split the template into the executable and its arguments, then launch the
  # executable directly: passing the whole command to cmd.exe loses the quotes
  # around an executable path with spaces, so the launch silently does nothing.
  $exePath = $null
  $rest = ''
  if ($command -match '^"(?<p>[^"]+\.exe)"\s*(?<r>.*)$') { $exePath = $Matches.p; $rest = $Matches.r }
  elseif ($command -match '^(?<p>[^\s"]+\.exe)\s*(?<r>.*)$') { $exePath = $Matches.p; $rest = $Matches.r }
  $rest = $rest.Replace('"%1"', ('"' + $file + '"')).Replace('%1', $file)
  if ($exePath) {
    if ($rest.Trim().Length -gt 0) {
      Start-Process -FilePath $exePath -ArgumentList $rest -WindowStyle Hidden
    } else {
      Start-Process -FilePath $exePath -ArgumentList @('"' + $file + '"') -WindowStyle Hidden
    }
  } else {
    $resolved = $command.Replace('"%1"', ('"' + $file + '"')).Replace('%1', $file)
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $resolved) -WindowStyle Hidden
  }
  return $true
}
foreach ($key in $exact) { if (Invoke-Command-Key $key $file) { exit 0 } }
foreach ($key in $related) { if (Invoke-Command-Key $key $file) { exit 0 } }
exit 3`
  debug(`open-with-command: app=${application}`)
  try {
    await run(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', program], signal)
    return true
  } catch (error) {
    mark(`registered command lookup failed for ${application}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Open one path with its registered Windows application.
 *
 * Upstream `openNativePath` spawns bare `powershell.exe -Command
 * "Invoke-Item -LiteralPath '<path>'"`; under the systemd-managed service that
 * name does not resolve (no `/mnt/c/Windows/**` in PATH), so the route fails
 * with ENOENT and the card shows "打开失败". Resolve PowerShell by absolute path
 * instead.
 *
 * Pass the **native Windows path**, single-quoted (`-LiteralPath`): a
 * `file://` URI fails here — measured `DriveNotFoundException` for
 * `file:///D:/...`, because `Invoke-Item` resolves a drive, not a URL.
 * Single quotes are the PowerShell literal form, so spaces and CJK are safe,
 * and an embedded `'` is doubled.
 *
 * @param path - absolute Host path.
 * @param signal - caller lifetime.
 */
async function openNativePath(path, signal) {
  const windowsPath = await toWindowsPath(path, signal)
  const literal = windowsPath.replace(/'/g, "''")
  debug(`open branch: literal=${literal}`)
  const startedAt = Date.now()
  await run(powershellExecutable(), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Invoke-Item -LiteralPath '${literal}'`,
  ], signal)
  debug(`open ok in ${Date.now() - startedAt}ms`)
}

/**
 * Translate a Host path to the Windows path the desktop understands.
 *
 * @param path - absolute Host path.
 * @param signal - caller lifetime.
 * @returns the Windows path (identity when already running on win32).
 */
async function toWindowsPath(path, signal) {
  if (process.platform !== 'win32' && !isWsl()) throw new Error('native open requires Windows or WSL')
  if (!isAbsolute(path)) throw new Error('native open requires an absolute path')
  if (process.platform === 'win32') return path
  const stdout = await new Promise((resolve, reject) => {
    execFile('wslpath', ['-w', path], { encoding: 'utf8', signal, windowsHide: true }, (error, out) =>
      error === null ? resolve(out) : reject(error),
    )
  })
  signal?.throwIfAborted()
  const windowsPath = stdout.replace(/[\r\n]+$/, '')
  if (windowsPath === '') throw new Error('wslpath returned no Windows path')
  debug(`wslpath -> ${windowsPath}`)
  return windowsPath
}

/**
 * Open Explorer on `path` and select the file.
 *
 * Every translated Windows path goes through the Shell namespace
 * (`Shell.Application` + `Document.SelectItem`). The upstream
 * `explorer.exe /select` handoff is not used because its argument encoding is
 * unreliable for exactly the files users care about — measured on this host in
 * a regular Windows folder (e.g. `D:\work\probe`):
 *
 * | file name                    | `/select,<file:///D:/...>` URI | `/select,<raw path>` |
 * |------------------------------|-------------------------------|----------------------|
 * | `ascii-only.docx`            | selects                       | selects              |
 * | `space name.docx`            | selects                       | opens the wrong dir  |
 * | `纯中文名.docx`               | selects nothing (wrong dir)   | selects              |
 *
 * A percent-encoded URI drops non-ASCII names and a raw path breaks on spaces,
 * so neither form is safe alone; the Shell namespace handled all three. The
 * cost is one PowerShell launch (~3-4s) per reveal.
 *
 * If selection cannot be proven, the containing folder is opened anyway so the
 * gesture still lands somewhere useful.
 *
 * @param path - absolute Host path already authorized by the caller.
 * @param signal - caller lifetime; abort terminates the child.
 */
export async function revealInExplorer(path, signal) {
  const windowsPath = await toWindowsPath(path, signal)
  const folder = windowsDirname(windowsPath)
  const name = win32.basename(windowsPath)
  debug(`shell-namespace branch: folder=${folder} name=${name}`)
  const startedAt = Date.now()
  try {
    await runPowershellSelect(folder, name, signal)
    debug(`powershell select ok in ${Date.now() - startedAt}ms`)
    return
  } catch (error) {
    debug(`powershell select failed after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`)
    // Selection is best effort: fall back to just opening the folder, and
    // keep the reason visible in the service log for diagnosis.
    signal?.throwIfAborted()
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : ''
    console.warn(`wsl-file-open: Shell selection failed (exit=${code})${stderr === '' ? '' : `: ${stderr}`}`)
    await runExplorer([folder], signal)
    return
  }
}

/**
 * Opt-in phase timings, enabled with DSH_WSL_FILE_OPEN_DEBUG=1.
 *
 * Kept in the shipping shell because the UNC path spans three processes
 * (node -> PowerShell -> Explorer) and "it felt slow" is otherwise
 * unattributable.
 */
const debug = (message) => {
  if (DEBUG) mark(message)
}

export const inject = ['sessionController']

/**
 * Install the reveal shim on the live Session controller.
 *
 * The seam is `openWorkspacePath`, the method the `/api/present.open` route
 * calls. `revealPath` looks like the obvious seam (it is the internal
 * `SessionControllerInternals` hook) but a write to it does not take effect:
 * after a cold start the route kept using the upstream opener, which is what
 * produced a window on the user profile's Documents folder instead of the file's folder.
 *
 * Do **not** verify the install by comparing `controller.openWorkspacePath`
 * with the value just written: `ctx.sessionController` is a cordis proxy whose
 * `get` returns a freshly rebound function on every read (`a.fn === a.fn` is
 * false, and `ctx.get(name) !== ctx[name]`). The assignment does reach the
 * service; the only meaningful verification is end-to-end — the route went
 * through this shim and `revealInExplorer` ran.
 *
 * @param ctx - Host context carrying `sessionController`.
 */
export function apply(ctx) {
  // `ctx.get(name)` and `ctx[name]` can hand back different proxies (measured:
  // `a === b` is false). Install on every reference we can obtain, otherwise
  // the service may keep reading an unpatched one.
  const candidates = []
  try {
    candidates.push(typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined)
  } catch (error) {
    mark(`ctx.get threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    candidates.push(ctx.sessionController)
  } catch {}
  const unique = candidates.filter((c, i) => c !== undefined && c !== null && candidates.indexOf(c) === i)
  if (unique.length === 0) {
    ctx.logger?.warn?.('wsl-file-open: sessionController unavailable; native open stays active')
    return
  }

  for (const controller of unique) {
    mark(`installing on controller: has fileApplications=${typeof controller.fileApplications} openFileApplication=${typeof controller.openFileApplication} openPath=${typeof controller.openPath} revealPath=${typeof controller.revealPath}`)

    // 0.2 split the native desktop work into four replaceable integrations.
    // Overriding them (rather than openWorkspacePath) keeps the controller's own
    // path verification, error mapping, and wire schema in charge.
    if (typeof controller.fileApplications === 'function') {
      controller.fileApplications = (path, signal) => {
        mark(`fileApplications called path=${path}`)
        return nativeFileApplications(path, withSignal(signal), { run: runWithAbsolutePaths })
          .then((apps) => {
            mark(`fileApplications ok -> ${apps.length} apps`)
            return apps
          })
          .catch((error) => {
            mark(`fileApplications FAILED: ${error instanceof Error ? error.message : String(error)}`)
            throw error
          })
      }
    }
    if (typeof controller.openFileApplication === 'function') {
      controller.openFileApplication = async (path, application, signal) => {
        mark(`openFileApplication app=${application} path=${path}`)
        const usedCommand = await openWithRegisteredCommand(path, application, withSignal(signal))
        if (usedCommand) {
          mark('openFileApplication via registered command: ok')
          return
        }
        mark('openFileApplication: no registered command, using native handler')
        return openNativeFileApplication(path, application, withSignal(signal), { run: runWithAbsolutePaths })
      }
    }
    if (typeof controller.openPath === 'function') {
      controller.openPath = (path, signal) =>
        openNativeAssociatedPath(path, withSignal(signal), { run: runWithAbsolutePaths })
    }
    // Selection: Shell namespace instead of `explorer.exe /select` (see above).
    if (typeof controller.revealPath === 'function') {
      controller.revealPath = (path, signal) => revealInExplorer(path, signal)
    }
  }
  ctx.logger?.info?.(`wsl-file-open: native desktop integrations installed on ${unique.length} controller reference(s)`)
}

// The Loader's `unwrapExports()` collapses a namespace to its `default` export,
// so a bare `default: apply` drops the named `inject` export and the dependency
// is never registered (apply could then run before `sessionController` exists).
// Exporting the object preserves `inject` for cordis's plugin registry.
export default { inject, apply }
