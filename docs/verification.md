# Verification

## 1. Host metadata

```bash
TOKEN=$(journalctl --user -u dsh-web --since "2 hours ago" \
  | grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)
curl -c /tmp/c.jar -b /tmp/c.jar -L -o /dev/null "http://127.0.0.1:30808/?token=$TOKEN"

curl -b /tmp/c.jar http://127.0.0.1:30808/api/present.host
# {"name":"<host>","available":true,"fileManager":"explorer"}

curl -b /tmp/c.jar http://127.0.0.1:30808/open-in-app/apps
# {"apps":["filemanager"]}  — expected, the button uses the xdg-open shim
```

## 2. Reveal a real card

Use a card in the web UI, or replay its route. The coordinates come from the
`deliverables/presented` event (`sessionId`, `seq`, file `index`):

```bash
curl -b /tmp/c.jar -X POST -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:30808/api/present.open?sessionId=<id>&seq=<n>&index=0&action=reveal"
# 204
```

Confirm on the Windows side that the folder is right **and the file is selected**:

```powershell
$sh = New-Object -ComObject Shell.Application
foreach ($w in @($sh.Windows())) {
  $p = ''; try { $p = $w.Document.Folder.Self.Path } catch {}
  if ($p -like '*<folder-fragment>*') {
    $f = $w.Document.FocusedItem
    "path=$p focused=$($f.Name) selected=$(@($w.Document.SelectedItems()).Count)"
  }
}
```

## 3. Default application

```bash
curl -b /tmp/c.jar -X POST -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:30808/api/present.open?sessionId=<id>&seq=<n>&index=0"
# 204
```

Check that the registered application window title contains the file name.

## 4. "Open with…" list and a specific application

```bash
curl -b /tmp/c.jar -X POST -H 'content-type: application/json' \
  -d '{"app":"filemanager","path":"/home/<user>/some-folder"}' \
  http://127.0.0.1:30808/open-in-app/open
# {"ok":true}
```

The application list itself is a WebSocket remote (`session.workspacePathApplications`),
so verify it in the UI: the "Open with…" menu must list real Windows handlers with icons,
and choosing one must open the file.

## 5. Diagnostic log

```bash
tail -n 20 /tmp/dsh-wsl-file-open.log
```

Useful lines:

- `installing on controller: has fileApplications=function …` — the plugin loaded
- `fileApplications called path=…` / `fileApplications ok -> N apps`
- `openFileApplication app=… path=…`
- `registered command …` with `DSH_WSL_FILE_OPEN_DEBUG=1`

## 6. Sanity checks

- `ps -o lstart= -p $(systemctl --user show dsh-web -p MainPID --value)` must be **after**
  your last edit, otherwise the service is still running old code.
- `dsh --dump-config --profile web | grep -A1 wsl-file-open` must show the entry as a
  `file://…` URL.
