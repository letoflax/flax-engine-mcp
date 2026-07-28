# Flax MCP Editor Bridge protocol (v5 / v1)

`FlaxMcpBridge.cs` is an Editor-only Flax 1.12 plugin. It uses only files below
`<project>/Cache/MCP`; it does not open a network listener.

At startup the bridge creates `requests/`, `processing/`, and `responses/`, then
writes these project-local files:

- `bridge.json`: `{ "BridgeVersion": 5, "ProtocolVersion": 1, "Pid": 123, "Project": "...", "EditorVersion": "1.12.6912", "Timestamp": 0 }`.
  It is atomically rewritten every two seconds. `Timestamp` is Unix milliseconds.
- `token`: a fresh 256-bit base64url session token. The bridge requires it on every
  request and deletes it on normal shutdown. It is marked hidden where the host
  filesystem supports that attribute; callers must treat `Cache/MCP` as private.

The Node client writes `requests/<id>.json` using a temporary file then rename.
`id` is 1–128 ASCII alphanumeric, `_`, or `-` and must equal the filename stem; the bridge atomically moves it to
`processing/` before reading it, so a request is executed at most once by one
bridge instance. A response is atomically written to `responses/<id>.json`.

Request fields are lowercase `id`, `token`, `method`, `paramsJson`, and `deadlineUnixMs`.
`paramsJson` is a JSON string, not an arbitrary object, and is capped at 64 KiB.
`deadlineUnixMs` is Unix milliseconds; it may be zero or within the next 60 s.
Response fields are lowercase `id`, `token`, `ok`, `errorCode`, `error`, `resultJson`, and `timestamp`.
The client rejects a response unless its token matches the active session token
using a constant-time comparison. Failure responses echo the request token; an
unauthorized request never receives the active session token.
Successful `resultJson` payload DTOs use PascalCase fields. Status results omit the
project path, and scene paths are project-relative; the heartbeat's project path
exists only so the local client can reject a bridge from another project.

Allowed methods: `status`, `scene.list_loaded`, `scene.get_tree`, `scene.save`,
`project.save_all`, actor CRUD/find/duplicate/reparent, narrowly scoped script
attach/detach/instance read/update, and `edit.undo`/`edit.redo`. The script update
surface only permits `Enabled`; arbitrary reflection-based property changes are
not exposed. `actor.update` permits only name, active, position, scale, and Euler
angles. The public Flax 1.12 API does not expose a reliable transaction/rollback
primitive for arbitrary operations, so bridge v5 advertises `TransactionsSupported:false`
and intentionally does not claim an atomic batch operation.
Recursive actor-tree results are bounded to 64 levels and 2,000 actors; larger
trees fail with `RESPONSE_TOO_LARGE` instead of exhausting the editor or client.

`actor.duplicate` delegates to Flax's undoable editor command. Flax 1.12 does not
return the new actor ID from that public command, so the response reports
`Verified:false` and `NewActorId:null`; clients must refresh the scene tree.
