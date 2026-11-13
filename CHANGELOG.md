# Changelog

## 0.1.2

- The shared folder is checked when the connector starts and before every save and list: a small file is
  written, read back and deleted. When that fails, the tools say why in plain words and what to do next,
  for example a Mac protecting Documents ("Operation not permitted"), instead of "the file could not be opened".
- A shared folder inside a temporary system folder (`/tmp`, `/var/folders`, the OS temp folder) is refused.
- Every `save_file` answer and refusal names the shared folder; `list_files` returns
  `{ sharedFolder, sharedFolderProblem?, files }` instead of a bare list.
- Refusals tell apart "this computer does not allow it", "no such file in the folder" and "not inside the folder".
- The suggested folder is directly in the home folder (for example `/Users/anna/suveren-files`), never Documents.
- New `get_status` (no arguments): `{ problem? }`, the same folder check, for the gateway to show on the
  connector's card. Internal to the gateway (manifest `status.tool`); the AI never sees it.

## 0.1.1

- `save_file`'s description names the real shared folder path, so the AI knows where to write a file. A missing-file refusal names the folder and the next step.

## 0.0.0

Unreleased. First build of the files connector: `save_file`, `list_files`, `get_file`.
