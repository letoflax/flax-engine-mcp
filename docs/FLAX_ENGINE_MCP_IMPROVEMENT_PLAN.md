# Flax Engine MCP — Kế hoạch cải tiến chi tiết

> Tài liệu này đề xuất lộ trình nâng cấp MCP hiện tại từ một **project file assistant** thành một **Flax Editor automation layer an toàn, có trạng thái và phù hợp cho AI agent**.

## 1. Tóm tắt điều hành

MCP hiện tại đã có nền tảng tốt cho các tác vụ đọc project, phân tích C#, tạo script và chỉnh sửa scene cơ bản. Tuy nhiên, phần lớn chức năng đang hoạt động bằng cách đọc/ghi trực tiếp file trong project. Cách này phù hợp cho phân tích tĩnh nhưng có các giới hạn lớn:

- Không biết Flax Editor đang mở scene nào, đang compile hay đang chạy game.
- Không tận dụng được Undo/Redo, dirty state và scene graph của Editor.
- Không thể thao tác đầy đủ với actor, script instance, prefab, asset database và play mode.
- Dễ xung đột nếu người dùng và MCP cùng sửa một file.
- Khó xác minh một thay đổi có thực sự compile hoặc chạy đúng trong engine.
- Chưa tận dụng đầy đủ các thành phần của MCP như Resources, Prompts, structured output, progress và cancellation.

Hướng cải tiến được khuyến nghị là giữ Node.js MCP server hiện tại, nhưng bổ sung một **Flax Editor Bridge viết bằng C#**. Node server tiếp tục phụ trách giao tiếp MCP, bảo mật đường dẫn, đọc source code và orchestration. Editor Bridge phụ trách các thao tác cần trạng thái runtime của Flax Editor.

Kiến trúc mục tiêu:

```text
Claude / MCP Client
        |
        | MCP stdio hoặc Streamable HTTP
        v
Node.js MCP Server
        |
        | Local IPC: Named Pipe / Unix Socket / localhost WebSocket
        v
Flax Editor Bridge Plugin (C#)
        |
        +-- SceneModule / SceneEditingModule
        +-- ContentDatabase / ContentImportingModule
        +-- PrefabsModule
        +-- ScriptsBuilder
        +-- SimulationModule
        +-- Editor Undo/Redo
        +-- GameCooker
```

### Kết quả mong muốn sau các phase chính

Sau Phase 1 và Phase 2, AI phải có thể thực hiện vòng lặp sau một cách an toàn:

```text
Đọc project và scene đang mở
→ tìm actor hoặc asset
→ preview thay đổi
→ chỉnh scene trong một transaction
→ compile script
→ đọc diagnostics
→ chạy game
→ thu log hoặc screenshot
→ sửa lỗi
→ lưu hoặc rollback
```

---

## 2. Đánh giá MCP hiện tại

### 2.1 Điểm mạnh

Bản hiện tại đã có 23 tool và bao phủ tương đối tốt các nhu cầu phân tích tĩnh:

- Đọc `.flaxproj`, `GameSettings.json` và các settings quan trọng.
- Liệt kê, đọc và ghi C# source.
- Parse class, field, method và attribute.
- Tìm reference trong source.
- Sinh script từ template.
- Đọc hierarchy từ `.scene`.
- Tạo và chỉnh một số thuộc tính actor.
- Liệt kê asset và GUID.
- Đọc log và compiler error.
- Validate project ở mức file.
- Có backup trước khi sửa scene.
- Chặn path traversal.
- Yêu cầu `overwrite:true` trước khi ghi đè script.

Đây là nền tảng tốt và không nên viết lại toàn bộ. Nên giữ các tool phân tích file nhanh, sau đó bổ sung Editor Bridge cho các thao tác cần trạng thái thực.

### 2.2 Khoảng trống chính

| Khoảng trống | Tác động |
|---|---|
| Không có kết nối với Flax Editor | Không biết scene đang mở, play mode, compile status hoặc dirty state |
| Chỉnh `.scene` trực tiếp | Không có Undo/Redo chuẩn, dễ lệch serialization hoặc xung đột với Editor |
| Actor API còn hẹp | Chỉ đổi tên, position và active; chưa sửa rotation, scale, parent, property, script |
| Asset chỉ được liệt kê | Chưa tìm kiếm sâu, import, reimport, dependency hoặc reference graph |
| Compile chỉ đọc log | Không thể chủ động compile và chờ kết quả |
| Không điều khiển play mode | Không thể chạy, pause, step frame hoặc kiểm thử runtime |
| Không có transaction | Tác vụ nhiều bước có thể để project ở trạng thái làm dở |
| Không có optimistic concurrency | Có thể ghi đè thay đổi mới của người dùng |
| Tool output chưa được chuẩn hóa | Agent khó lập kế hoạch và xử lý lỗi ổn định |
| Chưa có MCP Resources | Mọi context đều phải lấy qua tool call |
| Chưa có MCP Prompts | Chưa đóng gói workflow chuẩn cho người dùng |
| Chưa có progress/cancellation | Build, import, validate sâu có thể treo lâu và khó dừng |
| Chưa có permission profile | Một client đọc project có thể được cấp quá nhiều quyền |
| Chưa có integration test với Editor | Khó đảm bảo tương thích giữa các phiên bản Flax |

---

## 3. Mục tiêu thiết kế

### 3.1 Mục tiêu bắt buộc

1. **An toàn trước tiên**  
   Mọi thao tác ghi phải có preview, validation, concurrency check và khả năng rollback hoặc undo.

2. **Editor-aware**  
   Khi Editor Bridge khả dụng, mọi thao tác scene, actor, prefab, asset và play mode phải đi qua API của Editor.

3. **Graceful degradation**  
   MCP vẫn phải dùng được ở chế độ offline khi Flax Editor chưa mở. Tool cần chỉ rõ chức năng nào bị giới hạn.

4. **Structured và machine-readable**  
   Tool phải trả object ổn định theo `outputSchema`, không chỉ trả text tự do.

5. **Idempotent khi có thể**  
   Gọi lại một tool với cùng yêu cầu không được tạo actor hoặc asset trùng ngoài ý muốn.

6. **Quan sát được**  
   Có audit log, operation ID, revision, duration, warnings và danh sách file/object đã đổi.

7. **Tương thích đa project**  
   Mỗi server instance chỉ thao tác trong một project root đã cấu hình; không dùng global state giữa các project.

8. **Có khả năng kiểm thử tự động**  
   Unit test cho file parser, contract test cho MCP schema và integration test cho Editor Bridge.

### 3.2 Không phải mục tiêu ban đầu

Các tính năng dưới đây không nên nằm trong release đầu của kiến trúc mới:

- Cho AI chạy shell command tùy ý.
- `eval_csharp` hoặc thực thi code C# tùy ý trong Editor.
- Chỉnh binary asset bằng cách sửa byte trực tiếp.
- Hỗ trợ toàn bộ Visual Scripting graph.
- Điều khiển mọi cửa sổ UI của Flax Editor.
- Multiplayer test orchestration nhiều process.
- Full game profiling thay thế profiler chuyên dụng.

---

## 4. Kiến trúc mục tiêu

## 4.1 Node.js MCP Server

Node server tiếp tục là process được MCP client khởi chạy.

Trách nhiệm:

- MCP lifecycle và capability negotiation.
- Khai báo Tools, Resources và Prompts.
- Validate input/output bằng JSON Schema.
- Bảo vệ project root và path.
- Đọc source, docs và text settings.
- Cache metadata không nhạy cảm.
- Kết nối và reconnect tới Editor Bridge.
- Điều phối transaction nhiều bước.
- Chuẩn hóa lỗi từ filesystem, parser và Flax Editor.
- Ghi audit log.
- Quản lý permission profile.
- Cung cấp fallback offline.

Không nên để Node server tự sửa scene file khi Editor Bridge đang online, trừ tool migration hoặc recovery được người dùng yêu cầu rõ ràng.

## 4.2 Flax Editor Bridge Plugin

Một Editor Plugin C# được cài trong project hoặc dưới dạng plugin project dùng chung.

Trách nhiệm:

- Truy cập scene graph và object sống trong Editor.
- Resolve actor bằng GUID.
- Spawn, delete, duplicate, reparent và sửa property actor.
- Attach/detach script instance.
- Tích hợp Undo/Redo.
- Mark scene dirty và save bằng Editor API.
- Theo dõi script compilation và reload.
- Điều khiển SimulationModule.
- Truy cập Content Database, import và prefab.
- Trả progress của các tác vụ dài.
- Phát event khi scene, asset, compile status hoặc play status thay đổi.
- Dọn cache type/object khi scripts reload.

## 4.3 IPC giữa Node và Plugin

Khuyến nghị ưu tiên:

1. Named Pipe trên Windows và Unix Domain Socket trên Linux/macOS.
2. Localhost WebSocket nếu muốn đơn giản hóa đa nền tảng.
3. Không mở public network port mặc định.

Mỗi message IPC nên có dạng:

```json
{
  "requestId": "uuid",
  "method": "actor.create",
  "params": {},
  "projectId": "project-guid",
  "deadlineMs": 15000,
  "clientRevision": 42
}
```

Response:

```json
{
  "requestId": "uuid",
  "ok": true,
  "result": {},
  "editorRevision": 43,
  "warnings": [],
  "durationMs": 18
}
```

Yêu cầu bảo mật:

- Chỉ bind local machine.
- Handshake có random token được tạo lúc Editor plugin khởi động.
- Xác minh project path và project GUID ở cả hai phía.
- Giới hạn kích thước message.
- Timeout cho từng request.
- Không deserialize arbitrary .NET type từ payload.
- Chỉ expose method nằm trong allowlist.

## 4.4 Hai chế độ hoạt động

### Offline mode

Dùng khi Flax Editor chưa mở hoặc plugin chưa kết nối.

Cho phép:

- Đọc project, settings, source, docs và logs.
- Phân tích C#.
- Search text.
- Sinh script.
- Validate tĩnh.
- Đọc scene dạng file nếu parser hỗ trợ.

Hạn chế:

- Không chỉnh scene mặc định.
- Không compile bằng Editor.
- Không play game.
- Không có Undo/Redo.
- Không truy cập object runtime.

Có thể cho phép `--allow-offline-scene-write`, nhưng phải là opt-in rõ ràng.

### Editor-connected mode

Cho phép đầy đủ tool scene, actor, asset, compile, play, prefab và build.

Mọi response nên chứa:

```json
{
  "mode": "editor-connected",
  "editorVersion": "x.y",
  "bridgeVersion": "x.y",
  "projectRevision": 42
}
```

---

## 5. Chuẩn hóa tool contract

Trước khi thêm nhiều tool mới, cần chuẩn hóa contract chung.

## 5.1 Envelope kết quả

Mọi tool nên trả cấu trúc tương tự:

```json
{
  "ok": true,
  "operationId": "uuid",
  "mode": "offline|editor-connected",
  "data": {},
  "warnings": [],
  "changes": [],
  "revision": {
    "before": 12,
    "after": 13
  },
  "timing": {
    "durationMs": 24
  }
}
```

`changes` nên mô tả chính xác side effect:

```json
[
  {
    "kind": "actor.created",
    "id": "actor-guid",
    "path": "/Main/Environment/Rock"
  }
]
```

## 5.2 Error model

Phân biệt lỗi protocol và lỗi domain.

Ví dụ domain error:

```json
{
  "ok": false,
  "operationId": "uuid",
  "error": {
    "code": "ACTOR_NOT_FOUND",
    "message": "Actor with id ... was not found in loaded scenes.",
    "retryable": false,
    "details": {
      "actorId": "..."
    }
  }
}
```

Các mã lỗi tối thiểu:

- `EDITOR_NOT_CONNECTED`
- `EDITOR_BUSY`
- `PROJECT_MISMATCH`
- `SCENE_NOT_LOADED`
- `SCENE_REVISION_CONFLICT`
- `ACTOR_NOT_FOUND`
- `ASSET_NOT_FOUND`
- `SCRIPT_TYPE_NOT_FOUND`
- `COMPILATION_FAILED`
- `PLAY_MODE_REQUIRED`
- `PLAY_MODE_ACTIVE`
- `VALIDATION_FAILED`
- `PERMISSION_DENIED`
- `PATH_OUTSIDE_PROJECT`
- `FILE_CHANGED`
- `OPERATION_CANCELLED`
- `TIMEOUT`
- `UNSUPPORTED_FLAX_VERSION`

## 5.3 Tool annotations và risk level

Mỗi tool nên có metadata nội bộ:

| Risk | Ví dụ |
|---|---|
| `read` | `get_project_info`, `actor.get` |
| `safe-write` | `actor.rename`, `scene.save` |
| `destructive` | `actor.delete`, `asset.delete` |
| `runtime` | `play.start`, `build.cook` |
| `code-write` | `write_script`, `code.apply_patch` |

Các tool destructive phải hỗ trợ `dryRun:true` và có mô tả rõ về side effect.

## 5.4 Pagination và giới hạn dữ liệu

Các tool liệt kê phải hỗ trợ:

```json
{
  "cursor": null,
  "limit": 100
}
```

Áp dụng cho:

- `list_scripts`
- `list_assets`
- `find_references`
- `search_in_files`
- `scene.find_actors`
- `log.search`

Không trả toàn bộ project trong một response nếu project lớn.

---

## 6. Backlog tính năng theo mức ưu tiên

# Phase 0 — Củng cố nền tảng hiện tại

**Mục tiêu:** Làm cho 23 tool hiện có ổn định, có schema, kiểm thử được và sẵn sàng cho Editor Bridge.

**Mức ưu tiên:** P0  
**Kích thước tương đối:** M  
**Điều kiện hoàn tất:** Không thay đổi kiến trúc lớn nhưng mọi tool có contract và safety thống nhất.

## 6.1 `get_server_capabilities`

### Chức năng

Trả:

- MCP server version.
- Protocol version.
- Project path hash hoặc safe display path.
- Project GUID.
- Flax version phát hiện được.
- Editor Bridge connected hay không.
- Danh sách feature flags.
- Permission profile.
- Tool availability theo mode.

### Lý do

Agent cần biết tool nào thực sự khả dụng trước khi lập kế hoạch. Hiện tại việc có project path không đồng nghĩa Editor đang chạy hoặc tool scene có thể hoạt động an toàn.

### Acceptance criteria

- Trả kết quả trong dưới 100 ms ở trạng thái bình thường.
- Không lộ secret hoặc full path nếu cấu hình privacy mode.
- Có `capabilityRevision` để client phát hiện thay đổi.

---

## 6.2 Structured output và `outputSchema` cho toàn bộ tool

### Chức năng

- Khai báo `outputSchema`.
- Trả `structuredContent`.
- Giữ một TextContent ngắn để tương thích client cũ.
- Thống nhất error envelope.

### Lý do

Output text tự do khiến agent phải tự parse và dễ hiểu sai. Structured output giúp client validate kết quả và làm workflow nhiều bước ổn định hơn.

### Acceptance criteria

- 100% tool có schema input với `additionalProperties:false`.
- 100% tool có output schema.
- Contract test phát hiện breaking change.
- Không trả stack trace mặc định cho client.

---

## 6.3 `dryRun`, change summary và diff

Áp dụng cho:

- `write_script`
- `generate_script`
- `create_actor`
- `modify_actor`
- Các tool delete/move sẽ thêm sau này.

### Chức năng

Khi `dryRun:true`, tool không ghi dữ liệu mà trả:

- File/object sẽ đổi.
- Before/after summary.
- Validation warning.
- Estimated risk.
- Conflict nếu có.

### Lý do

AI cần xem trước side effect, đặc biệt khi yêu cầu của người dùng mơ hồ hoặc thay đổi nhiều object.

### Acceptance criteria

- Dry-run không thay đổi mtime, dirty state hoặc backup.
- Diff cho text dùng unified diff.
- Scene change dùng semantic diff theo actor/property, không chỉ diff JSON.

---

## 6.4 Optimistic concurrency

### Chức năng

Các tool ghi file nhận một trong các field:

- `expectedHash`
- `expectedModifiedAt`
- `expectedRevision`

Nếu dữ liệu đã đổi, tool trả `FILE_CHANGED` hoặc `SCENE_REVISION_CONFLICT`.

### Lý do

Ngăn MCP ghi đè thay đổi người dùng vừa thực hiện trong IDE hoặc Flax Editor.

### Acceptance criteria

- `write_script` không ghi nếu hash không khớp.
- Editor Bridge tăng revision sau mỗi transaction thành công.
- Error trả revision/hash mới để agent đọc lại.

---

## 6.5 `apply_script_patch`

### Chức năng

Thêm tool patch source thay vì luôn ghi toàn bộ file:

```json
{
  "path": "Source/Game/Player.cs",
  "expectedHash": "...",
  "patch": "...",
  "compileAfter": false
}
```

### Lý do

Patch giảm nguy cơ xóa nhầm code, giữ format tốt hơn và dễ audit.

### Acceptance criteria

- Patch phải apply sạch hoặc fail hoàn toàn.
- Không để file ở trạng thái nửa patch.
- Trả hash trước/sau và unified diff thực tế.
- Có giới hạn số dòng và kích thước patch.

---

## 6.6 Audit log

### Chức năng

Ghi JSON Lines tại thư mục cache riêng, ví dụ:

```text
Cache/FlaxMCP/audit-YYYY-MM-DD.jsonl
```

Mỗi record gồm:

- Timestamp.
- Operation ID.
- Tool.
- Client metadata nếu có.
- Risk level.
- Input đã redact.
- Files/actors/assets bị đổi.
- Kết quả.
- Duration.
- Undo transaction ID.

### Lý do

Cần truy vết khi agent tạo thay đổi sai và hỗ trợ debug MCP.

### Acceptance criteria

- Không ghi toàn bộ source code hoặc secret.
- Có rotation và max size.
- Tool `get_audit_entries` chỉ đọc trong project hiện tại.

---

## 6.7 Test suite cho chức năng hiện có

### Loại test

1. Unit test:
   - Path normalization.
   - `.flaxproj` parser.
   - Settings parser.
   - Scene parser.
   - C# parser.
   - Log parser.

2. Contract test:
   - Input/output schema.
   - Error codes.
   - Pagination.

3. Golden-file test:
   - Scene mẫu.
   - Settings mẫu.
   - Script có generic, nested type, attributes và partial class.

4. Security test:
   - Path traversal.
   - Symlink escape.
   - Oversized input.
   - Null byte.
   - Case sensitivity.
   - Malformed scene/settings.

### Lý do

Việc thêm Editor Bridge sẽ làm hệ thống phức tạp hơn. Cần khóa hành vi cũ trước khi mở rộng.

---

# Phase 1 — Flax Editor Bridge và scene editing an toàn

**Mục tiêu:** Chuyển scene mutation từ direct file editing sang Flax Editor API.

**Mức ưu tiên:** P0/P1  
**Kích thước tương đối:** XL  
**Đây là phase có giá trị cao nhất.**

## 6.8 `editor_get_status`

### Trả về

- Connected.
- Editor version.
- Project GUID.
- Idle/compiling/importing/building.
- Play state.
- Loaded scenes.
- Dirty scenes.
- Source dirty.
- Last compilation status.
- Current revision.

### Lý do

Mọi workflow cần kiểm tra Editor trước khi mutate.

### Acceptance criteria

- Không block main thread lâu.
- Status cập nhật đúng khi compile, reload scripts và play mode.
- Có field `canMutateScene`.

---

## 6.9 `scene_list_loaded`

### Chức năng

Liệt kê scene đang mở trong Editor:

- Scene asset ID.
- Name/path.
- Loaded state.
- Dirty state.
- Actor count.
- Active/primary scene.
- Revision.

### Lý do

`get_scene_actors` hiện đọc một `.scene` file, nhưng agent cần biết scene nào đang thực sự được chỉnh.

---

## 6.10 Nâng cấp `get_scene_actors` thành `scene_get_tree`

### Bổ sung

- Lấy scene sống từ Editor.
- Actor GUID.
- Hierarchy path.
- Type name.
- Parent ID.
- Sibling order.
- Local/world transform.
- Active state.
- Tags/layers nếu có.
- Attached scripts.
- Prefab relation.
- Pagination hoặc `maxDepth`.
- Filter theo type/name/tag/script.
- `includeProperties` tùy chọn.

### Lý do

Hierarchy đầy đủ là context nền cho mọi thao tác scene.

### Acceptance criteria

- Không serialize toàn bộ property mặc định nếu không được yêu cầu.
- Cây 10.000 actor vẫn có thể đọc bằng pagination/filter.
- ID ổn định giữa các call khi scene không thay đổi.

---

## 6.11 `actor_get`

### Chức năng

Đọc chi tiết một actor theo GUID:

- Metadata.
- Transform.
- Parent/children.
- Serialized property.
- Attached script.
- Asset references.
- Prefab overrides.

### Lý do

Không nên yêu cầu agent lấy cả scene chỉ để kiểm tra một actor.

---

## 6.12 Nâng cấp `create_actor`

### Bổ sung

```json
{
  "sceneId": "...",
  "parentId": null,
  "typeName": "FlaxEngine.StaticModel",
  "name": "Rock",
  "transform": {},
  "properties": {},
  "idempotencyKey": "...",
  "expectedRevision": 42,
  "dryRun": false
}
```

### Lý do

Tool hiện có chỉ thêm actor vào file scene. Bản mới cần resolve type trong Editor, spawn có Undo và cấu hình actor trong một transaction.

### Acceptance criteria

- Spawn bằng Editor API.
- Có Undo action.
- Nếu set property thất bại, actor không được giữ lại.
- `idempotencyKey` ngăn tạo trùng khi retry.
- Trả actor GUID và hierarchy path.

---

## 6.13 Nâng cấp `modify_actor` thành `actor_update`

### Bổ sung

- Name.
- Local/world position.
- Rotation quaternion hoặc Euler.
- Scale.
- Active.
- Parent.
- Sibling order.
- Tags/layers.
- Nhiều serialized properties.
- Script instance properties.
- Asset references.

### Lý do

Position, name và active là chưa đủ cho các workflow dựng scene thực tế.

### Acceptance criteria

- Patch semantics: chỉ field được gửi mới thay đổi.
- Validate type cho từng property.
- Gán asset bằng GUID, không dựa duy nhất vào path.
- Một call tạo một Undo transaction.

---

## 6.14 `actor_delete`

### Chức năng

- Xóa actor theo GUID.
- Tùy chọn xóa subtree.
- Dry-run liệt kê child và reference.
- Undo được.

### Lý do

Không có delete khiến agent không thể sửa cấu trúc scene hoàn chỉnh.

### Safety

- Mặc định từ chối xóa root scene.
- Cảnh báo nếu actor được reference.
- Có `expectedRevision`.
- Có `requireNoExternalReferences` tùy chọn.

---

## 6.15 `actor_duplicate`

### Chức năng

Nhân bản actor hoặc subtree, cho phép:

- Parent mới.
- Name policy.
- Transform offset.
- Sibling order.

### Lý do

Đây là thao tác phổ biến khi dựng level và nên dùng clone/serialization của Flax thay vì AI tự tái tạo từng property.

---

## 6.16 `actor_reparent`

### Chức năng

Chuyển actor sang parent mới, giữ world transform tùy chọn.

### Lý do

Hierarchy là một phần của logic scene. Reparent không nên được mô phỏng bằng xóa và tạo lại.

---

## 6.17 `actor_find`

### Bộ lọc

- Exact/contains/regex name.
- Type.
- Base type.
- Tag/layer.
- Attached script.
- Uses asset.
- Parent subtree.
- Active state.

### Lý do

Agent cần resolve object ổn định trước khi mutate. Tìm bằng tên duy nhất là không đủ vì tên có thể trùng.

---

## 6.18 `script_attach` và `script_detach`

### Chức năng

- Resolve type bằng full type name.
- Attach một script instance vào actor.
- Set initial serialized properties.
- Detach theo instance ID.
- Undo được.

### Lý do

MCP hiện có thể tạo file script nhưng chưa thể đưa behavior đó vào scene.

### Acceptance criteria

- Nếu script chưa compile, trả `SCRIPT_TYPE_NOT_FOUND` kèm gợi ý compile.
- Hỗ trợ nhiều instance cùng type.
- Không giữ reference .NET cũ qua script reload.

---

## 6.19 `script_instance_get` và `script_instance_update`

### Chức năng

Đọc/sửa public serialized fields và properties của script instance.

### Lý do

Đây là bước nối giữa code generation và cấu hình gameplay thực tế.

---

## 6.20 `scene_save`, `project_save_all`

### Chức năng

- Save một scene.
- Save tất cả dirty scene và asset.
- Trả danh sách item đã lưu.

### Lý do

MCP cần kiểm soát rõ thời điểm persist thay đổi. Không nên tự save sau mọi mutation nếu người dùng muốn review/undo.

### Policy đề xuất

- Mutation mặc định chỉ mark dirty.
- Workflow prompt có thể chọn `saveAtEnd:true`.
- Tool destructive không tự save nếu chưa commit transaction.

---

## 6.21 `edit_undo`, `edit_redo`

### Chức năng

Undo/redo thao tác Editor gần nhất hoặc transaction do MCP tạo.

### Lý do

Backup file không thay thế được Undo/Redo trong Editor.

### Acceptance criteria

- Response mô tả action đã undo.
- Không cho undo action của người dùng nếu policy chỉ cho phép MCP-owned history.
- Cấu hình `undoScope: "mcp-only" | "editor-global"`; mặc định `mcp-only`.

---

## 6.22 Transaction API

Các tool:

- `edit_begin_transaction`
- `edit_commit_transaction`
- `edit_rollback_transaction`
- `edit_get_transaction`

### Chức năng

Nhóm nhiều mutation thành một đơn vị atomic ở mức MCP.

### Lý do

Workflow như “tạo actor → attach script → gán model → set collider” không được để scene ở trạng thái dở dang nếu bước cuối lỗi.

### Acceptance criteria

- Transaction có TTL.
- Chỉ một write transaction trên cùng scene tại một thời điểm.
- Rollback khi disconnect hoặc timeout.
- Commit tạo một mục history rõ ràng.
- Không cho play/build bắt đầu khi có transaction chưa commit.

---

# Phase 2 — Compile, diagnostics và vòng lặp runtime

**Mục tiêu:** Cho agent tự kiểm chứng code và scene trong Flax.

**Mức ưu tiên:** P1  
**Kích thước tương đối:** L

## 6.23 `code_compile`

### Chức năng

Yêu cầu Flax compile source và chờ event hoàn tất hoặc trả task handle.

Input:

```json
{
  "wait": true,
  "timeoutMs": 120000,
  "generateProjectFirst": false
}
```

Output:

- Started.
- Success/failure.
- Compilation count.
- Duration.
- Diagnostics.
- Scripts reloaded.
- Editor ready.

### Lý do

`get_compiler_errors` hiện chỉ scan log thụ động. Agent cần chủ động compile sau khi sửa code.

### Acceptance criteria

- Không trigger compile trùng khi đang compile.
- Xử lý `ScriptsReloadBegin/End`.
- Clear object/type cache trước reload.
- Diagnostics có file, line, column, code, severity và message.

---

## 6.24 Nâng cấp `get_compiler_errors` thành `code_get_diagnostics`

### Bổ sung

- Diagnostics của lần compile gần nhất.
- Filter severity.
- Group theo file.
- Include context lines tùy chọn.
- Phân biệt stale diagnostics và current diagnostics.

### Lý do

Scan log bằng regex dễ lấy nhầm lỗi cũ. Bridge có thể gắn diagnostics với một compilation ID.

---

## 6.25 `code_generate_project`

### Chức năng

Yêu cầu Flax generate solution/project files.

### Lý do

Cần khi MCP tạo, xóa hoặc di chuyển file source/module.

---

## 6.26 `play_get_status`

### Trả về

- Stopped/starting/running/paused/stopping.
- Playing current scenes hay First Scene.
- Runtime duration.
- Frame count nếu khả dụng.
- Breakpoint hang.
- Last runtime exception.

### Lý do

Tool runtime phải biết trạng thái trước khi start/stop hoặc inspect.

---

## 6.27 `play_start_scenes`, `play_start_game`, `play_stop`

### Chức năng

- Chạy scene đang mở.
- Chạy từ First Scene.
- Dừng simulation.

### Lý do

Cho phép agent kiểm tra gameplay sau khi compile.

### Safety

- Mặc định từ chối start nếu compile đang fail.
- Cảnh báo nếu có scene dirty và policy yêu cầu save.
- Tự rollback transaction chưa commit trước khi play.

---

## 6.28 `play_pause`, `play_resume`, `play_step_frame`

### Lý do

Hữu ích để debug state machine, animation, physics và logic frame-based.

---

## 6.29 `play_run_for`

### Chức năng

Chạy game trong:

- N giây.
- N frame.
- Đến khi gặp log pattern.
- Đến khi condition adapter trả true.
- Có timeout bắt buộc.

### Lý do

Cho phép smoke test tự động mà không cần người dùng tự stop game.

### Acceptance criteria

- Luôn stop hoặc trả trạng thái rõ khi timeout.
- Hỗ trợ cancellation.
- Không block MCP server event loop.

---

## 6.30 Nâng cấp `get_latest_log` thành log service

Các tool:

- `log_get_recent`
- `log_search`
- `log_clear_session`
- `log_get_runtime_errors`

### Bổ sung

- Sequence number.
- Timestamp.
- Severity.
- Source/category.
- Compilation ID hoặc play session ID.
- Cursor.
- Regex/substring filter.
- `sinceSequence`.

### Lý do

Tailing file log thiếu session boundary và dễ trộn log cũ với log hiện tại.

---

## 6.31 `viewport_capture`

### Chức năng

Chụp screenshot của game viewport hoặc editor viewport và trả resource URI.

### Lý do

Log không phát hiện lỗi hình ảnh, camera sai, object bị lệch hoặc material hỏng. Screenshot giúp multimodal model đánh giá kết quả.

### Safety và performance

- Giới hạn resolution.
- Không auto-capture liên tục.
- Lưu vào cache tạm.
- Có TTL và cleanup.
- Không ghi vào Content trừ khi được yêu cầu.

---

## 6.32 `runtime_inspect_actor`

### Chức năng

Đọc snapshot actor trong play mode:

- Transform runtime.
- Active state.
- Script fields được allowlist.
- Parent/children.
- Selected performance counters cơ bản.

### Lý do

Scene file không phản ánh state runtime.

### Giới hạn

- Read-only ở release đầu.
- Không expose arbitrary reflection graph.
- Có depth và size limit.

---

# Phase 3 — Asset database, import và prefab

**Mục tiêu:** Cho MCP hiểu và quản lý content như một game editor thực thụ.

**Mức ưu tiên:** P1/P2  
**Kích thước tương đối:** XL

## 6.33 Nâng cấp `list_assets` thành `asset_search`

### Bộ lọc

- Name/path.
- Asset type.
- Extension.
- GUID.
- Folder.
- Modified time.
- Import source.
- Has missing dependency.
- Pagination.

### Output

- GUID.
- Virtual/project path.
- Type.
- Size.
- Modified time.
- Import status.
- Thumbnail resource URI nếu được yêu cầu.
- Dependency counts.

### Lý do

Liệt kê đơn giản không đủ cho project lớn.

---

## 6.34 `asset_get`

### Chức năng

Đọc metadata chi tiết một asset và import settings phù hợp với type.

### Lý do

Agent cần kiểm tra asset trước khi gán vào actor hoặc thay import settings.

---

## 6.35 `asset_get_dependencies` và `asset_find_references`

### Chức năng

- Asset này phụ thuộc asset nào.
- Scene/actor/asset nào đang dùng asset này.
- Phân biệt direct và transitive dependency.

### Lý do

Cực kỳ quan trọng trước khi move/delete và khi debug missing asset.

---

## 6.36 `asset_import`

### Chức năng

Import file source từ một thư mục được allowlist vào Content:

- Destination.
- Collision policy.
- Import settings.
- Wait/progress.
- Dry-run.

### Lý do

Cho phép agent đưa model, texture, audio vào project mà không yêu cầu thao tác tay.

### Safety

- Không cho đọc file ngoài allowlist.
- Giới hạn kích thước.
- Kiểm tra extension.
- Không overwrite mặc định.
- Scan duplicate destination.

---

## 6.37 `asset_reimport`

### Chức năng

Reimport asset hiện có, tùy chọn cập nhật settings.

### Lý do

Cần khi source asset thay đổi hoặc cấu hình import sai.

---

## 6.38 `asset_move`, `asset_rename`, `asset_duplicate`

### Lý do

Tổ chức Content là workflow phổ biến. Phải dùng Content Database/Editor API để giữ GUID/reference đúng.

### Acceptance criteria

- Không dùng filesystem rename thuần túy nếu có API Editor.
- Kiểm tra destination conflict.
- Trả reference impact.

---

## 6.39 `asset_delete`

### Safety bắt buộc

- `dryRun:true` mặc định.
- Liệt kê references.
- Yêu cầu `confirmReferenceCount` hoặc `requireUnreferenced:true`.
- Hỗ trợ trash/quarantine trước khi xóa vĩnh viễn.
- Audit đầy đủ.

### Lý do

Xóa asset là một trong các thao tác rủi ro nhất.

---

## 6.40 Prefab tools

Các tool:

- `prefab_create_from_actor`
- `prefab_instantiate`
- `prefab_get_instances`
- `prefab_get_overrides`
- `prefab_apply_overrides`
- `prefab_revert_overrides`
- `prefab_break_link`

### Lý do

Không có prefab API, AI sẽ lặp actor thủ công và tạo scene khó bảo trì.

### Phạm vi release đầu

Ưu tiên:

1. Create prefab.
2. Instantiate.
3. Get overrides.
4. Revert.

Apply override và break link có risk cao hơn, có thể đưa vào release sau.

---

# Phase 4 — MCP Resources, Prompts và event-driven context

**Mục tiêu:** Giảm tool call dư thừa và cung cấp workflow dễ khám phá.

**Mức ưu tiên:** P2  
**Kích thước tương đối:** M

## 6.41 MCP Resources

Đề xuất URI:

```text
flax://project/info
flax://project/summary
flax://project/settings
flax://editor/status
flax://scene/loaded
flax://scene/{sceneId}/tree
flax://actor/{actorId}
flax://asset/{assetId}
flax://asset/{assetId}/dependencies
flax://code/diagnostics/latest
flax://logs/recent
flax://build/status
flax://audit/recent
```

### Lý do

Resources phù hợp với dữ liệu chỉ đọc và có thể được client đưa vào context mà không giả vờ đây là một hành động.

### Yêu cầu

- Resource template cho scene/actor/asset.
- Annotation `lastModified`.
- Priority phù hợp.
- MIME type chính xác.
- Pagination hoặc summary cho resource lớn.
- Không trả source hoặc log vô hạn.

---

## 6.42 Resource subscriptions

Cho phép subscribe:

- `flax://editor/status`
- `flax://scene/{id}/tree`
- `flax://code/diagnostics/latest`
- `flax://logs/recent`

### Lý do

Client có thể biết context đã cũ sau scene mutation, compile hoặc play session.

### Giới hạn

- Debounce event.
- Không phát một notification cho mỗi frame hoặc mỗi log line.
- Dùng sequence/revision để client biết có cần đọc lại.

---

## 6.43 MCP Prompts

Đề xuất prompt:

### `create_gameplay_feature`

Workflow:

1. Đọc project conventions.
2. Tạo/patch script.
3. Compile.
4. Attach script.
5. Set properties.
6. Run smoke test.
7. Save hoặc rollback.

### `fix_compile_errors`

1. Đọc diagnostics current.
2. Đọc file liên quan.
3. Patch nhỏ nhất.
4. Compile lại.
5. Lặp với giới hạn số lần.

### `create_scene_from_description`

1. Preview actor plan.
2. Resolve asset.
3. Begin transaction.
4. Tạo hierarchy.
5. Validate.
6. Commit.
7. Capture screenshot.

### `debug_runtime_exception`

1. Start play.
2. Reproduce trong thời gian giới hạn.
3. Thu runtime log.
4. Stop.
5. Tìm source reference.
6. Đề xuất hoặc áp dụng patch.

### `prepare_release_build`

1. Save all.
2. Validate project.
3. Compile.
4. Kiểm tra First Scene/settings.
5. Cook.
6. Tổng hợp artifacts và warnings.

### Lý do

Prompts biến quy trình tốt thành tính năng dễ khám phá thay vì buộc người dùng nhớ từng tool.

---

# Phase 5 — Build, cook và validation sâu

**Mục tiêu:** Khép kín vòng đời từ source tới build artifact.

**Mức ưu tiên:** P2/P3  
**Kích thước tương đối:** L

## 6.44 `build_get_targets`

Trả platform, architecture và configuration được hỗ trợ trong project/Editor hiện tại.

## 6.45 `build_validate`

Kiểm tra:

- Project compile.
- First Scene tồn tại.
- Scene references hợp lệ.
- Missing asset.
- Invalid settings reference.
- Duplicate input mappings.
- Networked script configuration.
- Empty build target.
- Plugin/module dependency.
- Dirty scene.
- Unsupported platform setting.

### Lý do

`validate_project` hiện chủ yếu kiểm tra tĩnh. Build validation cần dữ liệu từ Editor và cooker.

---

## 6.46 `build_cook`

Input:

```json
{
  "platform": "...",
  "architecture": "...",
  "configuration": "Development",
  "outputPath": "...",
  "clean": false,
  "wait": false
}
```

### Lý do

Cho phép agent chuẩn bị build sau khi sửa project.

### Yêu cầu

- Progress.
- Cancellation.
- Build event stream hoặc task handle.
- Output path phải nằm trong allowlist.
- Không overwrite artifact ngoài policy.
- Trả warnings, errors và artifact manifest.

---

## 6.47 `build_get_status`, `build_cancel`, `build_get_result`

### Lý do

Cook/build là tác vụ dài và không nên giữ một tool call blocking vô hạn.

### Ghi chú MCP

Có thể bắt đầu bằng progress notification và operation handle riêng. MCP Tasks có thể được xem xét sau vì tính năng này còn mới/experimental trong spec 2025-11-25.

---

## 6.48 Validation rule framework

Thiết kế một hệ thống rule có ID:

```text
FLAX001 Missing first scene
FLAX002 Missing asset reference
FLAX003 Script compile failure
FLAX004 Duplicate actor name in required-unique scope
FLAX005 Invalid network attribute usage
FLAX006 Scene contains inactive required camera
```

Mỗi finding gồm:

- Rule ID.
- Severity.
- Object/file.
- Message.
- Suggested fix.
- Auto-fix availability.

### Lý do

Rule ID ổn định giúp CI, suppression và agent remediation.

---

# Phase 6 — Chất lượng nâng cao và domain tools

**Mục tiêu:** Mở rộng sau khi core workflow đã ổn định.

**Mức ưu tiên:** P3

## 6.49 Material tools

- `material_get_parameters`
- `material_set_parameters`
- `material_create_instance`
- `material_assign_to_actor`

**Lý do:** Material là nhu cầu phổ biến nhưng serialization và type system phức tạp hơn actor cơ bản.

## 6.50 Animation tools

- `animation_list_clips`
- `animation_get_graph_parameters`
- `animation_set_graph_parameter`
- `animation_validate_bindings`

**Lý do:** Hỗ trợ debug character setup; nên bắt đầu read-only.

## 6.51 Physics tools

- `physics_validate_colliders`
- `physics_raycast`
- `physics_get_layer_matrix`
- `physics_find_overlaps`

**Lý do:** Hữu ích cho gameplay debugging và level validation.

## 6.52 Navigation tools

- `navigation_build`
- `navigation_get_status`
- `navigation_validate_agents`
- `navigation_query_path`

**Lý do:** AI có thể kiểm tra navmesh thay vì chỉ đọc settings.

## 6.53 Lighting tools

- `lighting_bake`
- `lighting_get_status`
- `lighting_validate`
- `environment_probe_bake`

**Lý do:** Đây là tác vụ dài, cần progress/cancel và chỉ nên làm sau nền tảng task ổn định.

## 6.54 Terrain/Foliage tools

Chỉ nên thêm nếu có use case rõ vì API rộng và thay đổi scene lớn.

---

## 7. Cải tiến trực tiếp cho 23 tool hiện có

| Tool hiện tại | Quyết định | Cải tiến đề xuất | Phase |
|---|---|---|---|
| `get_project_info` | Giữ | Thêm project GUID, engine version, module, mode, revision | 0 |
| `get_game_settings` | Giữ | Chuẩn hóa reference thành asset GUID/path; báo missing ref | 0 |
| `get_project_summary` | Giữ nhưng giới hạn | Thêm section selection, token budget và cache revision | 0 |
| `list_scripts` | Giữ | Pagination, module, hash, class summary tùy chọn | 0 |
| `read_script` | Giữ | Hỗ trợ line range, hash, encoding và max bytes | 0 |
| `write_script` | Giữ có deprecate dần | Khuyến nghị `apply_script_patch`; thêm expectedHash và dry-run | 0 |
| `get_script_classes` | Giữ | Hỗ trợ namespace, partial class, generic và diagnostics parser | 0 |
| `find_references` | Giữ | Phân loại semantic/text reference; pagination | 0 |
| `list_networked_scripts` | Giữ | Rule-based findings, severity và file location | 0/5 |
| `search_in_files` | Giữ | Glob, regex safety, line context, cursor | 0 |
| `generate_script` | Giữ | Template registry, preview, namespace/module detection, compile option | 0/2 |
| `get_scene_actors` | Nâng cấp lớn | Dùng Editor scene graph, GUID, filter, maxDepth | 1 |
| `create_actor` | Nâng cấp lớn | Editor API, type validation, undo, transaction, idempotency | 1 |
| `modify_actor` | Đổi thành alias | Alias tới `actor_update`, hỗ trợ property rộng hơn | 1 |
| `list_assets` | Đổi thành alias | Alias tới `asset_search` | 3 |
| `read_settings` | Giữ | Schema-aware output, source asset GUID và validation | 0 |
| `get_input_actions` | Giữ | Phát hiện duplicate/conflict, action reference search | 0/5 |
| `get_physics_settings` | Giữ | Layer names/matrix, validation | 0/6 |
| `get_compiler_errors` | Đổi thành alias | Alias tới `code_get_diagnostics` khi bridge online | 2 |
| `validate_project` | Nâng cấp | Rule framework, online/offline validators, auto-fix metadata | 5 |
| `list_docs` | Giữ | Pagination và metadata | 0 |
| `read_doc` | Giữ | Line range, hash, front matter | 0 |
| `get_latest_log` | Đổi thành alias | Alias tới log service có session/sequence | 2 |

### Chính sách deprecation

- Giữ alias ít nhất hai minor release.
- Trả warning `deprecated`.
- README cung cấp migration table.
- Không đổi shape output trong cùng major version nếu không có compatibility layer.

---

## 8. Danh sách tool mục tiêu theo release

## Release A — Foundation

Khoảng 28–32 tool, gồm 23 tool hiện tại đã chuẩn hóa và:

```text
get_server_capabilities
apply_script_patch
get_audit_entries
editor_get_status
```

Mục tiêu: contract, safety, test và observability.

## Release B — Live Editor MVP

Thêm:

```text
scene_list_loaded
scene_get_tree
scene_save
project_save_all
actor_get
actor_find
actor_create
actor_update
actor_delete
actor_duplicate
actor_reparent
script_attach
script_detach
script_instance_get
script_instance_update
edit_undo
edit_redo
edit_begin_transaction
edit_commit_transaction
edit_rollback_transaction
```

Mục tiêu: AI chỉnh scene an toàn trong Editor.

## Release C — Compile and Play

Thêm:

```text
code_compile
code_get_diagnostics
code_generate_project
play_get_status
play_start_scenes
play_start_game
play_stop
play_pause
play_resume
play_step_frame
play_run_for
log_get_recent
log_search
log_get_runtime_errors
viewport_capture
runtime_inspect_actor
```

Mục tiêu: vòng lặp edit → compile → run → diagnose.

## Release D — Assets and Prefabs

Thêm:

```text
asset_search
asset_get
asset_get_dependencies
asset_find_references
asset_import
asset_reimport
asset_move
asset_rename
asset_duplicate
asset_delete
prefab_create_from_actor
prefab_instantiate
prefab_get_instances
prefab_get_overrides
prefab_revert_overrides
```

## Release E — Build and Advanced Validation

Thêm:

```text
build_get_targets
build_validate
build_cook
build_get_status
build_cancel
build_get_result
```

Cùng Resources, Prompts và subscription.

---

## 9. Permission model

Khuyến nghị hỗ trợ CLI:

```bash
--permission-profile read-only
--permission-profile code-edit
--permission-profile scene-edit
--permission-profile full
```

### `read-only`

- Đọc project/source/docs/scene/assets/log.
- Không ghi file.
- Không điều khiển play/build.

### `code-edit`

- Tất cả read.
- Create/patch source.
- Compile.
- Không sửa scene hoặc asset.

### `scene-edit`

- Read.
- Sửa scene/actor/script instance.
- Play mode.
- Không xóa asset hoặc cook build.

### `full`

- Tất cả capability.
- Tool destructive vẫn cần dry-run/confirmation policy.

Có thể thêm allow/deny override:

```bash
--allow-tool actor_delete
--deny-tool asset_delete
```

### Lý do

Nguyên tắc least privilege giảm thiệt hại nếu agent hiểu sai yêu cầu.

---

## 10. Cơ chế khóa và revision

## 10.1 Project revision

Editor Bridge giữ một counter tăng sau mỗi thay đổi có side effect.

## 10.2 Scene revision

Mỗi scene có revision riêng.

## 10.3 File hash

Text file dùng SHA-256 hoặc hash nhanh ổn định.

## 10.4 Write lock

- Một transaction ghi trên scene tại một thời điểm.
- Compile có thể khóa script mutation.
- Script reload khóa object reflection.
- Build/cook khóa mutation lớn.

### Lý do

AI workflow thường thực hiện nhiều call nối tiếp. Nếu không có revision và lock, kết quả call trước có thể đã lỗi thời.

---

## 11. Progress, cancellation và long-running operations

Tool cần progress:

- Compile.
- Asset import/reimport.
- Deep validation.
- Project summary trên project lớn.
- Build/cook.
- Lighting/navmesh bake.
- Reference graph toàn project.

Mỗi progress event gồm:

```json
{
  "operationId": "...",
  "progress": 0.42,
  "message": "Compiling Game module",
  "step": 3,
  "totalSteps": 7
}
```

Cancellation phải:

- Dừng ở safe checkpoint.
- Cleanup temp files.
- Rollback transaction nếu chưa commit.
- Trả `OPERATION_CANCELLED`.
- Không báo success nếu engine hoàn tất sau khi client đã cancel.

MCP Tasks chỉ nên được bật sau khi xác nhận client mục tiêu hỗ trợ tốt; trước đó có thể dùng tool trả operation handle và các tool status/cancel riêng.

---

## 12. Cache strategy

Có thể cache:

- Project info.
- Script index.
- Parsed class metadata.
- Asset metadata index.
- Docs index.

Không cache lâu:

- Loaded scene tree.
- Actor property.
- Editor status.
- Compile diagnostics current.
- Runtime object.

Mỗi cache entry phải gắn:

- Revision.
- Source hash/mtime.
- Created time.
- Expiry.
- Invalidation reason.

Invalidation event:

- File watcher.
- Content database change.
- Scene revision.
- Scripts reload.
- Project switch.
- Editor disconnect.

---

## 13. Security checklist

- [ ] Canonicalize project root.
- [ ] Chặn `..`, null byte và absolute path ngoài root.
- [ ] Xử lý symlink/junction escape.
- [ ] Giới hạn file extension cho read/write.
- [ ] Giới hạn kích thước file, patch và response.
- [ ] Không expose environment variables.
- [ ] Redact token/path nhạy cảm trong audit log.
- [ ] Local IPC authentication token.
- [ ] Không bind public interface mặc định.
- [ ] Tool allowlist.
- [ ] Permission profile.
- [ ] Timeout cho tất cả Editor call.
- [ ] Không deserialize arbitrary type.
- [ ] Không có shell/eval tool.
- [ ] Dry-run cho destructive operation.
- [ ] Reference check trước asset delete.
- [ ] Hash/revision check trước write.
- [ ] Temp file + atomic rename cho file write.
- [ ] Cleanup backup theo retention policy.
- [ ] Rate limit operation nặng.
- [ ] Có emergency read-only mode.

---

## 14. Testing strategy chi tiết

## 14.1 Node unit tests

- Project discovery.
- Multiple `.flaxproj`.
- Invalid `.flaxproj`.
- Settings reference resolution.
- C# encoding.
- Patch application.
- Search pagination.
- Error mapping.
- Output schema validation.
- Permission policy.

## 14.2 Editor Bridge unit tests

Tách logic có thể test khỏi Editor:

- DTO serialization.
- Type/property conversion.
- Actor patch validation.
- Transaction state machine.
- IPC authentication.
- Revision manager.
- Error mapping.

## 14.3 Editor integration tests

Tạo một fixture project nhỏ với:

- Hai scene.
- Actor hierarchy nhiều cấp.
- StaticModel, Camera, Light, Collider.
- Script thường và network script.
- Prefab.
- Texture/model/material.
- Một script compile fail có chủ đích.

Test:

1. Connect.
2. Read loaded scene.
3. Create actor.
4. Update transform.
5. Attach script.
6. Undo.
7. Redo.
8. Save.
9. Patch script.
10. Compile fail.
11. Fix.
12. Compile success.
13. Start play.
14. Read log.
15. Stop.
16. Import asset.
17. Instantiate prefab.

## 14.4 Compatibility matrix

CI hoặc manual test tối thiểu trên:

- Windows.
- Linux nếu Flax workflow hỗ trợ.
- macOS nếu project mục tiêu cần.
- Phiên bản Flax thấp nhất được hỗ trợ.
- Phiên bản Flax khuyến nghị.
- Flax latest được test riêng, không tự tuyên bố hỗ trợ nếu chưa pass.

## 14.5 Fault injection

- Editor đóng giữa transaction.
- Compile reload giữa actor call.
- IPC timeout.
- Malformed response.
- Scene đóng trước commit.
- File đổi giữa read và patch.
- Disk full.
- Permission denied.
- Build cancellation.
- Duplicate request retry.

---

## 15. Observability và chẩn đoán MCP

Thêm CLI:

```bash
--log-level debug
--trace-ipc
--audit-log
--diagnostics-port disabled-by-default
```

Thêm tool read-only:

```text
server_get_health
server_get_metrics
server_get_recent_errors
```

Metrics hữu ích:

- Tool call count.
- Error rate theo code.
- P50/P95 duration.
- IPC reconnect count.
- Compile duration.
- Scene transaction rollback count.
- Cache hit rate.
- Response size.

Không cần hệ thống telemetry cloud mặc định. Local metrics là đủ cho release đầu và tốt hơn cho privacy.

---

## 16. README và developer experience

README mới nên có:

1. Kiến trúc offline và editor-connected.
2. Cách cài Node server.
3. Cách cài Flax Editor Bridge.
4. Cách kiểm tra connection.
5. Permission profile.
6. Tool matrix theo mode.
7. Ví dụ workflow.
8. Safety model.
9. Compatibility matrix.
10. Troubleshooting.
11. Migration từ tool cũ.
12. Known limitations.

CLI nên thêm:

```text
--project-path
--permission-profile
--editor-bridge auto|required|disabled
--bridge-endpoint
--bridge-token-file
--allow-offline-scene-write
--max-response-bytes
--log-level
--audit-log
```

Thêm command chẩn đoán:

```bash
flax-engine-mcp doctor --project-path /path/to/project
```

`doctor` kiểm tra:

- Node version.
- Project file.
- Flax version.
- Plugin installed.
- Bridge endpoint.
- Permission.
- Cache directory.
- Source/settings readability.
- Protocol handshake.

---

## 17. Tiêu chí hoàn thành theo cấp độ

## Definition of Done cho một tool read

- Input/output schema.
- Permission annotation.
- Pagination nếu output có thể lớn.
- Unit test.
- Error codes.
- Documentation và example.
- Không lộ path/secret không cần thiết.
- Stable ordering hoặc nêu rõ không đảm bảo.

## Definition of Done cho một tool write

Ngoài các yêu cầu của read tool:

- Dry-run.
- Expected hash/revision.
- Atomicity.
- Audit record.
- Undo hoặc rollback.
- Change summary.
- Integration test.
- Destructive warning nếu phù hợp.
- Không tự save ngoài policy đã công bố.

## Definition of Done cho tool dài

Ngoài các yêu cầu trên:

- Progress.
- Timeout.
- Cancellation.
- Cleanup.
- Operation status.
- Không block event loop.
- Test cancellation và disconnect.

---

## 18. Thứ tự triển khai khuyến nghị

### Bước 1 — Khóa contract

- Chuẩn hóa schema.
- Error envelope.
- Hash/revision.
- Dry-run.
- Audit.
- Tests.

**Lý do:** Nếu bỏ qua bước này, mọi tool mới sẽ có API không nhất quán và khó sửa sau.

### Bước 2 — Xây Editor Bridge skeleton

- Plugin lifecycle.
- IPC.
- Handshake.
- `editor_get_status`.
- Main-thread dispatch.
- Reconnect.
- Scripts reload cleanup.

**Lý do:** Đây là nền cho gần như toàn bộ cải tiến quan trọng.

### Bước 3 — Scene read + actor CRUD + Undo

- Loaded scenes.
- Scene tree.
- Actor get/find/create/update/delete.
- Transaction.
- Save.
- Undo/redo.

**Lý do:** Mang lại giá trị rõ nhất cho user ngay lập tức.

### Bước 4 — Compile + diagnostics

- Patch source.
- Trigger compile.
- Compilation event.
- Reload-safe cache.
- Diagnostics by compilation ID.

**Lý do:** Cho phép agent xác minh code thay vì chỉ viết.

### Bước 5 — Play + logs + screenshot

- Simulation control.
- Runtime session.
- Structured logs.
- Run-for.
- Capture viewport.

**Lý do:** Hoàn thiện vòng lặp tự sửa lỗi.

### Bước 6 — Asset + prefab

- Search.
- Dependency.
- Import.
- Prefab create/instantiate.

**Lý do:** Nâng từ code assistant thành editor assistant.

### Bước 7 — Resources + Prompts

- Resource templates.
- Subscription.
- Workflow prompts.

**Lý do:** Cải thiện UX sau khi primitive tools đã ổn định.

### Bước 8 — Build + advanced domains

- Cooker.
- Validation framework.
- Material, physics, navmesh, lighting.

---

## 19. Ưu tiên nếu nguồn lực hạn chế

Nếu chỉ có thể triển khai khoảng 10–15 tính năng mới, nên chọn:

1. `get_server_capabilities`
2. `editor_get_status`
3. `scene_list_loaded`
4. `scene_get_tree`
5. `actor_get`
6. `actor_find`
7. `actor_create` qua Editor
8. `actor_update`
9. `actor_delete`
10. `edit_undo`
11. `edit_begin/commit/rollback_transaction`
12. `apply_script_patch`
13. `code_compile`
14. `code_get_diagnostics`
15. `play_start_scenes` / `play_stop`
16. `log_get_recent`

Đây là tập nhỏ nhất tạo được vòng lặp:

```text
inspect → edit → compile → run → diagnose → undo/save
```

Nếu chưa thể viết Editor Plugin, ưu tiên tạm thời:

1. Structured output.
2. Patch + expected hash.
3. Dry-run.
4. Semantic scene diff.
5. Audit log.
6. Better diagnostics.
7. Validation rules.
8. Tool pagination.
9. Permission profiles.
10. Comprehensive tests.

Tuy nhiên, direct scene-file editing không nên được xem là kiến trúc cuối cùng.

---

## 20. Rủi ro kỹ thuật và cách giảm thiểu

| Rủi ro | Cách giảm thiểu |
|---|---|
| API Flax thay đổi giữa phiên bản | Compatibility adapter và version gate |
| Scripts reload làm invalid .NET object | Chỉ cache GUID/type name; cleanup ở reload begin |
| Deadlock main thread | Queue request và dispatch rõ ràng; không block Editor thread chờ Node |
| Scene lớn làm response quá nặng | Filter, maxDepth, pagination, summary |
| Agent retry tạo duplicate | Idempotency key |
| User sửa cùng lúc | Expected revision/hash và write lock |
| Editor đóng giữa operation | Transaction TTL, rollback/recovery record |
| Build/import kéo dài | Progress, cancel, task handle |
| Asset delete phá reference | Dependency graph, dry-run, quarantine |
| IPC bị process khác gọi | Local-only endpoint và token handshake |
| Tool count quá lớn | Namespace rõ, prompt workflow và capability discovery |
| Output breaking change | Versioned schemas và deprecation window |

---

## 21. Naming convention đề xuất

Hiện tool dùng snake_case và không namespace. Có thể tiếp tục snake_case để tránh breaking change, nhưng nên nhóm theo prefix:

```text
server_get_capabilities
project_get_info
project_get_summary
editor_get_status
scene_list_loaded
scene_get_tree
scene_save
actor_get
actor_find
actor_create
actor_update
actor_delete
script_attach
script_instance_update
asset_search
asset_import
code_apply_patch
code_compile
code_get_diagnostics
play_start_scenes
play_stop
log_get_recent
edit_undo
build_cook
```

Không nên dùng tên mơ hồ như:

```text
execute
modify
manage_asset
run_command
```

Tên phải biểu đạt object và action.

---

## 22. Versioning

Đề xuất ba version độc lập:

- MCP server version.
- Editor Bridge protocol version.
- Tool contract version.

Handshake:

```json
{
  "serverVersion": "2.0.0",
  "bridgeVersion": "1.0.0",
  "bridgeProtocolVersion": "1",
  "flaxVersion": "...",
  "toolContractVersion": "2"
}
```

Quy tắc:

- Patch: bug fix, không đổi schema.
- Minor: tool mới hoặc field optional mới.
- Major: rename/remove field, đổi semantics.
- Bridge từ chối kết nối nếu major protocol không tương thích.
- Có feature flags thay vì suy đoán theo version.

---

## 23. Roadmap tóm tắt

| Phase | Kết quả | Ưu tiên | Size |
|---|---|---:|---:|
| 0 | Contract, safety, patch, audit, tests | P0 | M |
| 1 | Editor Bridge, scene/actor, undo/transaction | P0/P1 | XL |
| 2 | Compile, diagnostics, play, logs, screenshot | P1 | L |
| 3 | Asset database, import, dependency, prefab | P1/P2 | XL |
| 4 | MCP Resources, subscriptions, Prompts | P2 | M |
| 5 | Build/cook và validation framework | P2/P3 | L |
| 6 | Material, animation, physics, nav, lighting | P3 | XL |

---

## 24. Khuyến nghị quyết định kiến trúc

### Quyết định 1: Có xây Editor Bridge hay không?

**Khuyến nghị: Có.**

Đây là thay đổi quan trọng nhất. Nếu không có bridge, MCP sẽ bị giới hạn ở file tooling và không thể trở thành một game-engine MCP hoàn chỉnh.

### Quyết định 2: Có bỏ direct scene editing ngay không?

**Khuyến nghị: Không bỏ ngay, nhưng chuyển thành fallback opt-in.**

Giữ compatibility trong một thời gian, thêm warning và ưu tiên Editor mode.

### Quyết định 3: Có thêm toàn bộ tool ngay không?

**Khuyến nghị: Không.**

Tập trung vào primitive đáng tin cậy. Workflow phức tạp nên được xây bằng Prompts và orchestration từ các primitive đó.

### Quyết định 4: Có dùng MCP Tasks ngay không?

**Khuyến nghị: Chưa bắt buộc.**

Bắt đầu với progress, cancellation và operation handle. Thêm MCP Tasks khi client mục tiêu hỗ trợ ổn định và test đầy đủ.

### Quyết định 5: Có cho AI tự save không?

**Khuyến nghị: Mutation chỉ mark dirty; save là bước rõ ràng.**

Prompt workflow có thể bật `saveAtEnd`, nhưng primitive tool không nên âm thầm persist mọi thay đổi.

---

## 25. Kết luận

Bản MCP hiện tại là một nền tảng tốt cho **đọc và chỉnh project ở mức file**, nhưng cải tiến có giá trị nhất không phải chỉ là tăng số lượng tool. Cần thay đổi theo ba trục:

1. **Từ file-based sang Editor-aware**  
   Bổ sung Flax Editor Bridge để thao tác scene, actor, asset, compile và play mode bằng API thực.

2. **Từ thao tác đơn lẻ sang workflow an toàn**  
   Thêm revision, dry-run, transaction, undo, audit, progress và cancellation.

3. **Từ text response sang MCP-native interface**  
   Structured output, Resources, Prompts, subscriptions và capability discovery.

Release mang lại giá trị cao nhất nên tập trung vào:

```text
Editor connection
→ loaded scene tree
→ actor CRUD
→ transaction + undo
→ code patch + compile diagnostics
→ play control + structured logs
```

Khi vòng lặp này ổn định, asset/prefab, build/cook và các domain tool nâng cao sẽ có nền tảng đủ chắc để mở rộng mà không làm MCP trở nên khó kiểm soát.

---

## 26. Tài liệu kỹ thuật tham khảo

- Model Context Protocol specification: `https://modelcontextprotocol.io/specification/2025-11-25`
- MCP Tools and structured output: `https://modelcontextprotocol.io/specification/2025-11-25/server/tools`
- MCP Resources: `https://modelcontextprotocol.io/specification/2025-11-25/server/resources`
- MCP Prompts: `https://modelcontextprotocol.io/specification/2025-11-25/server/prompts`
- MCP Progress: `https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress`
- MCP Cancellation: `https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation`
- MCP Tasks: `https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks`
- Flax custom editor plugin: `https://docs.flaxengine.com/manual/scripting/tutorials/custom-plugin.html`
- Flax Editor API: `https://docs.flaxengine.com/api/FlaxEditor.Editor.html`
- Flax SceneModule: `https://docs.flaxengine.com/api/FlaxEditor.Modules.SceneModule.html`
- Flax SceneEditingModule: `https://docs.flaxengine.com/api/FlaxEditor.Modules.SceneEditingModule.html`
- Flax SimulationModule: `https://docs.flaxengine.com/api/FlaxEditor.Modules.SimulationModule.html`
- Flax ScriptsBuilder: `https://docs.flaxengine.com/api/FlaxEditor.ScriptsBuilder.html`
- Flax Editor modules: `https://docs.flaxengine.com/api/FlaxEditor.Modules.html`
