# @humanagencyp/files-mcp

Files connector (MCP server over stdio, command `files-mcp`) for the Human Agency Protocol.
A file gets in once, from a shared folder. From then on an AI only names it by id. The AI never types a file
and never handles its bytes.

## Environment

| Variable | Meaning |
|---|---|
| `FILES_FOLDER` | The shared folder, set by a person (a full path; the folder itself must not be a symbolic link, its parents may be). Suggest one directly in the home folder, such as `/Users/anna/suveren-files`. Unset: `save_file` refuses; the other tools work. |
| `HAP_DATA_DIR` | Data directory (default `~/.hap`). Files are stored in `<dataDir>/files-store/`, the index in `<dataDir>/files.db` (SQLite). |

## Tools

| Tool | Input | Output |
|---|---|---|
| `save_file` | `{ file }` a plain file name in the shared folder | `{ id, filename, contentType, bytes, sha256, warnings[], sharedFolder }` |
| `list_files` | `{ limit? }` | `{ sharedFolder, sharedFolderProblem?, files: [{ id, filename, contentType, bytes, sha256, created_at }] }` |
| `get_file` | `{ kind: "file", id }` | `{ filename, contentType, contentBase64, sha256, warnings }` (the ERP connector's result shape plus the fixed warning sentences recorded at save; internal to the gateway) |

## The shared folder check

At start, when the tools are listed, and before every `save_file` and `list_files`, the connector checks
the folder by doing what it needs there: it writes a small file (`.suveren-files-check-<random>`), reads it
back and deletes it. There is no list of protected folders; the operating system answers:

- macOS: privacy protection refuses a background program in Documents, Desktop, Downloads and iCloud
  Drive (`Operation not permitted`), even when the AI app may write there.
- Linux, macOS and Windows: plain permissions refuse with `Permission denied` (on Windows also
  Controlled folder access, if it is on).

A temporary system folder (`/tmp`, `/var/tmp`, `/var/folders` and their `/private` forms, `/dev/shm`, the
OS temp folder, `TMPDIR`/`TEMP`/`TMP`, `C:\Windows\Temp`) is refused by name: other programs can read it
and the computer empties it.

A folder that cannot be used does not stop the connector. `save_file`'s description, every `save_file`
refusal and every `list_files` answer say why, in plain words, with the next step. Every refusal names the
folder.

## `save_file`, in this order (each failure is a plain refusal and stores nothing)

1. `file` is a bare name: no separator (`/` or `\`), not `.` or `..`, no NUL, not absolute.
2. Not a symbolic link; the shared folder itself is not one (its parents may be) and must not be swapped for one during the call. Opened without following links, then the
   open handle is checked (regular file, one name only (no hard link), same file as the path names, inside the folder). Read from that handle only.
3. At most 18,000,000 bytes (18 MB). One byte more is refused.
4. Type from the content: PDF, PNG, JPEG, WebP, GIF, MP4, WebM, Markdown (`.md`), plain text (valid UTF-8, no NUL).
   Everything else is refused, including Word, Excel, SVG, zip and whole HTML/XML files. Markdown with inline HTML passes.
5. PDF: refused if it holds JavaScript, a `/Launch` action, an `/OpenAction` other than a destination or `/GoTo`, an embedded file, encryption, or encoding that cannot be
   inspected. Warnings (fixed sentences): form fields, annotations, incremental updates.
6. The bytes read in step 2 are copied under a server-generated id (UUID), SHA-256 of exactly those bytes. Files are
   created read-only and never overwritten; the index refuses UPDATE and DELETE. The same bytes saved twice get two ids.

The stored file name has control characters and bidi marks removed and is cut to 200 characters.

## Symlink protection per platform

Node has no `openat`, so the strongest protection (resolving every component relative to a directory handle) is not available.

| | macOS | Linux | Windows |
|---|---|---|---|
| File itself is a link | refused (lstat, then `O_NOFOLLOW`) | same | refused (lstat); no `O_NOFOLLOW` in Node |
| File swapped for a link between check and open | open fails (`ELOOP`) | same | not prevented; caught afterwards only if the file's identity changed |
| Shared folder itself is a link | refused (lstat; re-checked after open) | same | same |
| Folder swapped for a link during the call | detected after open (folder lstat/realpath and file dev/ino re-checked) | detected after open (also `/proc/self/fd` path must equal realpath(folder)/name) | detected after open as on macOS |
| Reading | from the open handle, once | same | same |
| Named pipe / device | refused (`O_NONBLOCK`, fstat) | same | fstat |

Tested on macOS only. Linux and Windows are written for but not run.

## Gateway note

`get_file` for an 18 MB file is one JSON line of about 48 MB (base64, once in `content` and once in
`structuredContent`). The MCP SDK stdio client closes the connection when a line exceeds its default read buffer of
10 MiB, so the client must be created with a larger `maxBufferSize`.
