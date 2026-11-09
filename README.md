# @humanagencyp/documents-mcp

A document connector (MCP server over stdio, command `documents-mcp`) for the Human Agency Protocol.
A file gets in once, from a shared folder. From then on an AI only names it by id. The AI never types a file
and never handles its bytes.

## Environment

| Variable | Meaning |
|---|---|
| `DOCUMENTS_FOLDER` | The shared folder, set by a person (a full path, no symbolic link in it). Unset: `save_document` refuses; the other tools work. |
| `HAP_DATA_DIR` | Data directory (default `~/.hap`). Documents are stored in `<dataDir>/documents-store/`, the index in `<dataDir>/documents.db` (SQLite). |

## Tools

| Tool | Input | Output |
|---|---|---|
| `save_document` | `{ file }` a plain file name in the shared folder | `{ id, filename, contentType, bytes, sha256, warnings[] }` |
| `list_documents` | `{ limit? }` | `[{ id, filename, contentType, bytes, sha256, created_at }]` |
| `get_document` | `{ kind: "file", id }` | `{ filename, contentType, contentBase64, sha256 }` (same shape as the ERP connector; internal to the gateway) |

## `save_document`, in this order (each failure is a plain refusal and stores nothing)

1. `file` is a bare name: no separator (`/` or `\`), not `.` or `..`, no NUL, not absolute.
2. Not a symbolic link, and no component of the shared-folder path is one. Opened without following links, then the
   open handle is checked (regular file, same file as the path names, inside the folder). Read from that handle only.
3. At most 25 MiB (26214400 bytes). One byte more is refused.
4. Type from the content: PDF, PNG, JPEG, WebP, GIF, MP4, WebM, Markdown (`.md`), plain text (valid UTF-8, no NUL).
   Everything else is refused, including Word, Excel, SVG, HTML, XML and zip.
5. PDF: refused if it holds JavaScript, any `/OpenAction`, an embedded file, encryption, or encoding that cannot be
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
| Folder path component is a link | refused (lstat of every component) | same | same |
| Parent swapped for a link during the call | detected after open (components and dev/ino re-checked) | detected after open (also `/proc/self/fd` path must equal the expected path) | detected after open as on macOS |
| Reading | from the open handle, once | same | same |
| Named pipe / device | refused (`O_NONBLOCK`, fstat) | same | fstat |

Tested on macOS only. Linux and Windows are written for but not run.

## Gateway note

`get_document` for a 25 MiB file is one JSON line of about 70 MB (base64, once in `content` and once in
`structuredContent`). The MCP SDK stdio client closes the connection when a line exceeds its default read buffer of
10 MiB, so the client must be created with a larger `maxBufferSize`.
