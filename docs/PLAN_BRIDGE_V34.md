# Kế hoạch cải thiện MCP theo phản hồi của agent flax-test (bridge v34 → v35)

> **Trạng thái (2026-10-03): v34 (P1–P4) và v35 (P5) đã triển khai và chạy live, chưa commit.** Điểm xuất phát: commit `e325794` (bridge v33, server 1.11.0, 169 tool). Kết quả ở các mục "Kết quả v34", "Kết quả v35" cuối file và các mục "Bridge v34 live run", "Runtime bridge v35 live run" của `docs/TESTING.md`.

## Bối cảnh

Agent làm game ở `D:\Code\flax\flax-test` gửi danh sách điểm nghẽn khi dùng bridge.
Rà code cho thấy ba loại nguyên nhân:

1. **Lỗi thật trong MCP**:
   - `ResultAssetId` không bao giờ được gán khi import.
   - Reader GUID offline phía Node in ra một dạng GUID thứ ba.
   - Nhiều Editor trên cùng project ghi đè `token` của nhau.
2. **Thiếu tính năng**: quit, chờ Editor sẵn sàng, reload scene từ đĩa, scene replace, ghi field lồng nhau, tham chiếu asset trên script lúc edit, node graph tổng quát, bridge cho bản cook.
3. **Agent đi vòng qua lớp Node**: `Tools/mm_bridge.py` gọi file-RPC thô trong `Cache/MCP`. Vì vậy agent phải tự tạo OperationId, tự gửi AllowedImportRoots, và nhận `METHOD_NOT_ALLOWED`. Những việc này lớp Node vốn lo sẵn.

Mục tiêu:
- sửa các lỗi trên;
- thêm công cụ đi đúng đường Editor/engine tự dùng;
- cho script Python gọi được tool MCP thay vì gọi bridge thô.

Quyết định đã chốt với bạn (2026-10-02):
- Làm bridge runtime cho bản cook, là phase cuối với version riêng (v35).
- Thêm đủ nhóm vòng đời: quit, chờ sẵn sàng, option tắt auto-compile, launch Editor/game (bật bằng cờ CLI).
- Gộp anim graph với X3 của `flax-test/docs/WEATHER_PLUGIN_PLAN.md` thành một bộ graph tổng quát ở v34.
- Import root vẫn bắt buộc khai báo bằng cờ, nhưng nhận đường dẫn tương đối theo project.
- **Ngoại lệ được duyệt**: transition của state machine được gọi qua reflection vào member internal của Editor. Đó chính là đường Editor tự dùng, chỉ là không public.

Nguyên tắc giữ nguyên:
- Chỉ thêm tool khi nó đi qua đường Editor/engine dùng; không có thì giữ stub `UNSUPPORTED_FLAX_VERSION`.
- Chỉ thêm tool tổng quát.
- Mở rộng tool sẵn có khi đủ, thay vì thêm tool mới.
- Không commit khi chưa hỏi.
- Chỉ chạy live trên bản sao TestFlax.

## Đối chiếu phản hồi

| Phản hồi | Nguyên nhân đã kiểm | Xử lý |
|---|---|---|
| Bridge chỉ có trong Editor | Cả file nằm trong `#if FLAX_EDITOR` (`bridge/FlaxMcpBridge.cs:6`) | P5 |
| Hot reload lỗi `LNK1104` khi sửa code lúc Editor mở | Lỗi link khi hot reload native (game `BuildNativeCode`, plugin C++). Việc của engine/project, MCP không sửa được | P2: vòng quit → build offline → launch → chờ sẵn sàng; option tắt auto-compile |
| Phải `Stop-Process -Force` | Không có lệnh quit | P2 |
| `Game.Gen.*` bị ghi đè | Flax.Build ghi branch/commit vào file sinh ra, mà repo game lại track các file này | Ngoài MCP |
| Không tạo được Slot, Blend Space, transition có điều kiện | Bridge chỉ spawn được (9,18), (9,20), (9,2); các tool sửa node chỉ chạm root context | P4 |
| `reload` giữ giá trị cũ | `scene.open` dùng `Level.LoadSceneAsync` và no-op khi scene đã load. Khả năng cao `SceneAsset` còn trong cache của Content | P3, probe trước |
| Không ghi được field lồng nhau / asset id trên script | `script.instance_set_value` dùng bộ chuyển kiểu cũ `CoerceScriptFieldValue` (`:7766`); `ResolveMemberSlot` (`:8367`) hiểu `A.B` là `Type.Member` | P3 |
| Hai dạng GUID | Bridge dùng dạng "N", file scene dùng dạng native, reader offline của Node in dạng thứ ba | P1 |
| OperationId và AllowedImportRoots bắt buộc | Lớp Node đã tự lo; agent gọi bridge thô | P2 `flax-mcp call`, P1 nhận root tương đối |
| Không có `replace` khi trùng tên | Chỉ có `error`/`rename` | P1, chỉ làm nếu probe xác nhận giữ được asset ID |
| `ResultAssetId` null | Nhánh import không gán (`:1243-1290`) | P1 |
| Không import theo lô | Mỗi lần gọi một file | P1 `items[]` |
| `ping` trả `METHOD_NOT_ALLOWED` | Nhánh `default` của switch dispatch (`:790`) | P1 |
| `scene.open` thêm chứ không thay | Như trên | P3 cờ `replace` |
| Capture cần play mode, không chọn được kích thước | Engine không cho chọn kích thước capture | P5 có capture ở bản cook; kích thước vẫn từ chối |
| Không có lệnh chờ Editor sẵn sàng | Không có | P2 |
| Tạo AudioSource/Light/UI rồi lưu prefab trong một bước | Đã ghép được bằng `actor_create` + `actor_set_property` + `prefab_create_from_actor` | Chỉ thêm công thức vào README |

## P1 — Sửa lỗi (bridge v34)

**Bridge** (`bridge/FlaxMcpBridge.cs`)

1. **`ResultAssetId` sau import.** Sau khi import xong trong `StartAssetImport` (`:1243-1290`): gọi `RefreshContentDatabaseFrom`, lấy ID từ registry, nếu chưa có thì đọc header như `CreatedAssetMetadata` (`:10067-10094`). Sửa câu sai ở `PROTOCOL.md:318`.
2. **Bản ghi import.**
   - Giữ qua script reload, như các operation khác (`RestorePersistentState`, `:11305`).
   - Key `_assetImportOperations` (`:486`) không phân biệt hoa thường.
3. **`collision_policy: "replace"`** đi đúng đường `ContentImportingModule.Reimport`, tức `Import(source, existingOutputPath)`.
   - Chỉ bật nếu probe (WP-F) xác nhận asset ID và kiểu asset giữ nguyên.
   - Cần `confirm:true`.
   - Nếu ID đổi thì không làm, ghi lý do vào PROTOCOL.
4. **Method lạ.**
   - Nhánh `default` trả `METHOD_NOT_FOUND` kèm `Details.Methods`.
   - Thêm mảng tĩnh `KnownMethods`; `status` trả thêm `Methods`.
   - Contract test: `KnownMethods` khớp đúng các nhãn `case`.
5. **Nhiều Editor trên cùng project.**
   - Khi khởi động, nếu `bridge.json` mang PID khác còn sống và heartbeat còn mới: vào standby (không ghi token/heartbeat, không poll `requests/`, log cảnh báo), kiểm lại định kỳ, nhận quyền khi PID kia chết.
   - Khi thoát, chỉ xóa `token`/`bridge.json` (`:548-549`) nếu PID trong file là của mình.

**Node**

6. **GUID.** Thêm `src/guid.ts` với `nativeToManaged`/`managedToNative`, theo `docs/GUID_AUDIT_P7.md`; test bằng ví dụ AR15 trong tài liệu đó.
   - Reader offline (`src/tools/assets.ts:43`, `assetInfo.ts:33`, `validation.ts:33`) in dạng "N" như bridge.
   - `validation.ts:134-144` đổi tham chiếu native trong scene sang "N" trước khi so; hết báo sai FLAX002.
   - `sceneWrite.ts` đổi dạng khi đọc/ghi.
   - Sửa `readTools.test.ts:106-110`.
   - Thêm mục "GUID forms" vào PROTOCOL.
7. **`asset_import`** (`src/tools/assetImport.ts`)
   - `destination.renamed` lấy từ quyết định rename của Node (`:260-267`).
   - Khi start lỗi TIMEOUT/DEADLINE, trả `operation_id` trong details để poll tiếp.
   - Dùng `mapBridgeError` thay cho `importError` riêng.
   - Thêm `items[]` (≤32): gọi lần lượt; `wait` chờ hết; trả kết quả từng mục.
8. **`--asset-import-root`** nhận đường dẫn tương đối theo project (`src/assetImportPolicy.ts:42-82`). README thêm ví dụ `Content/Raws`.
9. **`src/bridge/mapBridgeError.ts`**
   - `METHOD_NOT_FOUND` ánh xạ giống `METHOD_NOT_ALLOWED`, giữ nguyên hành vi của `mm_apply_preset`.
   - `UNAUTHORIZED` (token đổi vì Editor tự recompile) ánh xạ sang `EDITOR_BUSY` kèm `{retryable:true, reason:'bridge_session_changed'}`. Không tự retry thao tác ghi thiếu idempotency key.

## P2 — Vòng đời Editor và CLI (v34)

1. **`flax-mcp call <tool> [json|@file]`** và **`flax-mcp tools`**.
   - Xử lý như `doctor` (`src/index.ts:88`), trước `parseProjectPath` (`:36`).
   - Vẫn đọc `--project-path`, `--permission-profile`, `--asset-import-root`, `--flax-editor`.
   - Gọi `dispatchToolCall` (`:48`), in JSON, mã thoát 0/1/2.
   - README có ví dụ thay lời gọi thô kiểu `mm_bridge.py` bằng `flax-mcp call`.
2. **Chờ sẵn sàng: mở rộng `editor_get_status`**, không thêm tool. Schema hiện đang rỗng (`src/tools/serverStatus.ts:12`).
   - Tham số mới: `wait_ready`, `timeout_ms` (≤300 s), `require_scene`, `min_bridge_version`.
   - Bridge `status` (`:799-806`) thêm `EditorState`, `IsEditMode`, `IsCompiling`, `ScriptsReady`, `IsImporting`, `LastCompileFailed`, `LoadedSceneCount`.
   - Node coi heartbeat gián đoạn lúc reload là "đang reload", dùng lại `pollOperation`/`isReloadTransient` (`src/tools/runtimeLive.ts:154-213`), có gửi progress.
3. **`editor_quit`** (family runtime). Tham số `unsaved: refuse|save|discard` (mặc định `refuse`) và `stop_play`.
   - Kiểm cả scene dirty lẫn cửa sổ asset có `IsEdited`.
   - Từ chối khi đang import, compile hoặc cook.
   - Trong play mode: có `stop_play` thì dừng và chờ `PlayModeEnd`, không có thì từ chối.
   - Ghi response xong mới đặt cờ; frame sau `OnUpdate` gọi `Engine.RequestExit()`. Đây là đường `-exit` của Editor; lý do `EngineExit` không hiện hộp thoại.
   - Node chờ tới khi PID thoát.
4. **`editor_launch`** (runtime). Chỉ bật khi server chạy với `--flax-editor <FlaxEditor.exe>`; không có cờ thì trả `UNSUPPORTED` kèm gợi ý.
   - Từ chối nếu project còn heartbeat sống, hoặc có `FlaxEditor.exe` đang chạy với `-project <project này>`.
   - Chỉ nhận cờ `headless` và `skip_compile`; không nhận tham số tự do. Tùy chọn `wait_ready`.
   - Sửa câu "This server never launches an editor process" (`assetInfo.ts:17,119`, `src/tools/index.ts:1155`).
5. **`editor_options`** (family code): đọc khi không có `set`; ghi cần `confirm:true`.
   - Allow-list: `General.AutoReloadScriptsOnMainWindowFocus`, `General.ForceScriptCompilationOnStartup`.
   - Ghi theo cách cửa sổ Editor Options bấm Save: chép sâu `Editor.Options.Options`, đổi giá trị, gọi `Editor.Options.Apply(copy)`.
   - Từ chối khi cửa sổ Editor Options đang mở.
   - Kết quả có `scope:"user-global"` và `previous`. Mô tả nói rõ: file `%AppData%/Flax/EditorOptions.json` dùng chung cho mọi Editor của user, các Editor khác chỉ nhận khi khởi động lại; tắt auto-compile thì play dùng assembly cũ.
6. **Headless.**
   - README thêm mục "Headless workflow": import, reimport, compile, settings, thao tác file scene chạy được; bake, graph, capture thì không.
   - Probe `navigation_build` ở headless (chạy bằng CPU); nếu đúng thì nới gate.

## P3 — Scene và ghi member (v34)

1. **`scene_open` + `replace`**: gọi `ChangingScenesState.ChangeScenes([id], others)`.
   - Scene sắp bị unload mà đang dirty thì cần `discard_unsaved`.
   - Nếu target đã load thì chỉ unload các scene khác (`TryEnter` hủy scene nằm ở cả hai danh sách).
2. **`scene_open` + `reload:true`**. WP-F probe trước để chốt nguyên nhân. Luồng dự kiến chạy qua nhiều frame:
   1. `ChangingScenesState.UnloadScene(scene)`, chờ unload xong;
   2. nếu `SceneAsset` còn trong cache thì `Asset.Reload()`;
   3. `LoadScene(id, additive:true)`.
   - Scene dirty thì cần `discard_unsaved`.
   - Trả `disk_sha256` của file đã đọc.
   - Docs cảnh báo: autosave của Editor có thể ghi đè file sửa từ ngoài khi scene còn mở.
3. **`script_instance_set_value` chuyển sang đường của `actor_set_property`**: `CoerceMemberValue` (`:8997`) + `MemberWriteBlockReason` (`:8329`) + `ScriptMemberInfo.SetValue`.
   - Tham chiếu asset nhận GUID, `Content/...` hoặc `engine:`.
   - Undo bằng `Undo.RecordAction(script, …)`, như ở `:7189`, `:8048`.
   - Giữ tên field và dạng response cũ.
4. **Field lồng nhau**: tham số `path` (mảng tên, sâu ≤4) cho `script_instance_set_value`, `runtime_set_script_value`, `actor_set_property`.
   - Mỗi cấp phải editor-visible theo `GenericEditor.GetItemsForType`.
   - Cấp trung gian là struct của user, hoặc class khác null nhưng không phải Asset/SceneObject.
   - Đợt này chưa nhận mảng/list.
   - Ghi như property grid (`CustomEditor.cs:383-403`): đặt giá trị lá vào bản sao của cấp cha, rồi ghi ngược từng cấp lên member gốc. Chỉ một undo snapshot trên script/actor sở hữu.
   - `script_instance_get include_values` đọc được giá trị lồng nhau, có giới hạn.
5. **Viết lại contract test đang ghim code cũ** (`src/bridge/bridgeV7Contract.test.ts:384`, `:480-505`).

## P4 — Graph Visject tổng quát (v34, gộp X3 weather)

1. **`graph_list_archetypes`** (read): các node dùng được trong một context, gồm group/type, tên, box vào/ra, layout values.
   - Root và state context lấy từ `NodeFactory` + `CanUseNodeType`.
   - Context state machine và transition: spike, vì danh sách nằm private trong `AnimGraphSurface`.
2. **`graph_edit`** (asset): một lô `ops[]` gồm `add_node`, `connect`, `disconnect`, `set_values`, `move`, `remove`.
   - Mỗi op có `context_path` (đường node-ID như `graph_inspect`); tham chiếu `$n1` trỏ tới node vừa tạo trong cùng lô.
   - Dry-run mặc định; cả lô chỉ `Save()` một lần.
   - Đánh dấu modified mọi context trên đường đi, vì `VisjectSurfaceContext.Save` chỉ lưu context con có `IsModified`.
   - Xong thì trả cửa sổ về view cũ.
   - Slot (9,32), Multi Blend 1D/2D (9,12/13), Any (9,34) thêm bằng `add_node`. Điểm blend và `{clip, speed, loop, start}` của node Animation là values, đặt bằng `set_values`.
   - Các tool `graph_set_node_values`, `graph_move_node`, `graph_remove_node`, `graph_disconnect` giữ nguyên (chỉ root).
3. **`animgraph_set_transition`** (asset): chọn transition theo (state nguồn, state đích).
   - Đặt được `blend_duration`, `blend_mode`, `enabled`, `solo`, `use_default_rule`, `interruption`, `order`.
   - Rule có điều kiện: dùng `graph_edit` với `context_path` trỏ vào transition, mở bằng `OpenContext(transition)` như `EditRule()`.
   - Theo ngoại lệ đã duyệt: dùng reflection gọi `StateMachineStateBase.Transitions` và setter của `StateMachineTransition`.
     - Kiểm member tồn tại lúc chạy; thiếu thì trả `UNSUPPORTED_FLAX_VERSION`.
     - Không tự encode blob byte của transition.
     - Có contract test; PROTOCOL ghi rõ ngoại lệ này.
4. **X3 weather**
   - Thêm cửa sổ `MaterialFunction` vào whitelist graph (`ParticleEmitterFunction` nếu rẻ).
   - `asset_create` nhận kind `GameplayGlobals` kèm `variables`.
   - Spike module particle: nếu `SpawnNode` không gắn được vào stack thì thêm op `add_particle_module` cho `graph_edit`.
   - Không làm `model.generate_sdf`.
5. **Nghiệm thu**
   - Dựng toàn bộ `flax-test/docs/ZOMBIE_ANIM_GRAPH.md` qua MCP trên bản sao, với một model skinned và 5 clip bất kỳ chép vào scratch. Play thử với một script test đổi `State`.
   - Smoke X3: material có node hằng màu nối vào output và compile được; MaterialFunction 2 node; thêm module vào emitter.

## P5 — Bridge runtime cho bản cook (v35, làm sau khi v34 xong)

1. **File riêng `bridge/FlaxMcpRuntimeBridge.cs`**
   - Bọc `#if FLAX_GAME && !BUILD_RELEASE`, là một `GamePlugin`.
   - Tự đủ, không dùng chung file với bridge Editor, để installer và việc vendor ở flax-test đơn giản.
   - Không chạy gì nếu thiếu `-mcpdir=<abs>`.
   - `-mcpinstance=<name>`, mặc định là PID.
2. **Mỗi instance một thư mục**: `requests/`, `processing/`, `responses/`, `captures/`, `token`, `bridge.json` (`Kind:"game"`, PID, instance). `game_launch` truyền `<project>/Cache/MCP-Runtime/<instance>`.
3. **Method**:
   - `status`, `runtime.invoke_script_method`, `runtime.set_script_value`, `runtime.inspect_actor`;
   - `capture.start` qua `Screenshot.Capture`, kích thước bằng cửa sổ game;
   - `log.query`: ring nhận từ `Debug.Logger.LogHandler.SendLog`;
   - `time.set_scale`, `perf.snapshot`;
   - `game.quit`: `Engine.RequestExit` ở frame sau.

   Không có giả lập input, vì engine không có API (lý do như v26). Thay vào đó dùng `invoke` gọi hook debug của game.

   Ở bản cook không có `ScriptMemberInfo` (kiểu này thuộc FlaxEditor), nên ghi và gọi qua `System.Reflection`, với cùng giới hạn như bản Editor:
   - chỉ type khai báo trong game;
   - kiểu vô hướng, Guid, Vector, Color, asset theo GUID;
   - không ghi state actor của engine.

   PROTOCOL ghi rõ điểm khác với hợp đồng v28 (hợp đồng đó chỉ áp cho Editor).
4. **Node**
   - `game_launch` (runtime): chỉ bật với `--allow-game-launch`.
     - exe phải nằm trong project (`Builds/`, `Cache/`);
     - tham số game tối đa 32 chuỗi khớp `^-[A-Za-z0-9_]+(=[^\s"]{0,256})?$`;
     - server tự thêm `-mcpdir` và `-mcpinstance`.
   - `game_list_instances` (read).
   - `game_stop` (runtime): gửi `game.quit` rồi chờ PID thoát; `force` chỉ kill PID do chính server này launch.
   - Tham số `instance` tùy chọn cho `runtime_set_script_value`, `runtime_invoke_script_method`, `runtime_inspect_actor`, `viewport_capture`, `log_get_recent`, `log_search`, `log_get_runtime_errors`, `perf_get_snapshot`, `play_set_time_scale`.
5. **Installer**: `install_editor_bridge` thêm `include_runtime`. `get_editor_bridge_installation` báo hash từng file (`src/tools/bridgeInstaller.ts:18,149-153,221-240`).
6. **Compile smoke thứ hai**: define `FLAX_GAME;BUILD_DEVELOPMENT`, tham chiếu bản game `Flax_1.12/Source/Platforms/Windows/Binaries/Game/x64/Development/FlaxEngine.CSharp.dll` (không có FlaxEditor) để bắt mọi phụ thuộc vào Editor.

## Điểm sửa chung mỗi version

- **Version bridge** khai ở 5 chỗ: `FlaxMcpBridge.cs:1` (header), `:41`, `:46`, `:389`, `:532`.
- **Phía Node**:
  - `CURRENT_BRIDGE_VERSION` (`bridgeV7Contract.test.ts:13`);
  - `BRIDGE_V34` (`src/tools/liveToolSupport.ts:9`);
  - `test/compatibility-matrix.json:24`;
  - `SERVER_VERSION` (`src/version.ts:2`) và `package.json`: 1.12.0 cho v34, 1.13.0 cho v35.
- **Số tool**: v34 thêm `editor_quit`, `editor_launch`, `editor_options`, `graph_list_archetypes`, `graph_edit`, `animgraph_set_transition` (169 → 175). v35 thêm `game_launch`, `game_list_instances`, `game_stop` (→ 178; `mm_apply_preset` gỡ sau đó → 177).
- **Cần cập nhật**:
  - đếm tool trong `src/contracts.test.ts:26,29,76`;
  - `src/permissions.ts`;
  - map mutation trong `src/resourceSubscriptions.ts:98-104`;
  - `mapBridgeError.test.ts`;
  - `test/flax-api-smoke/VisjectGraphApiCompileProbe.cs`.
- **Docs**:
  - README: mục Permissions và các bảng tool;
  - PROTOCOL: mục "Bridge v34" / "Bridge v35", "GUID forms", "Headless workflow", ngoại lệ reflection;
  - `docs/TESTING.md`;
  - lưu plan này thành `docs/PLAN_BRIDGE_V34.md`.

## Thứ tự và chia việc

Hầu hết thay đổi rơi vào một file bridge, nên làm theo cách đã dùng ở v33 follow-up. Mỗi gói chạy trên bản sao working tree không có `.git` và trả về một patch; một agent gộp.

1. **Chạy song song trước**
   - **WP0**: khung v34.
     - Bump version.
     - Mọi `case` mới trỏ tới stub `UNSUPPORTED`.
     - Field `McpStatus` mới (dòng `:46` là một dòng dài, hay xung đột).
     - `KnownMethods`.
     - Phía Node: entry registry, permission, số tool, contract test.
   - **WP-F**: probe trên bản sao TestFlax, chỉ đọc. Probe:
     - nguyên nhân reload scene;
     - `replace` có giữ ID không;
     - `navigation_build` headless;
     - member internal của transition;
     - archetype trong context state machine;
     - gắn module particle.
2. **Sau WP0, chạy song song**

   | Gói | Phạm vi |
   |---|---|
   | WP-A | P1 phần bridge |
   | WP-B | P1/P2 phần chỉ Node: `guid.ts`, CLI, import, mapper, `editor_launch` |
   | WP-C | P2 phần bridge, cộng phía Node của `editor_get_status` / `editor_quit` / `editor_options` |
   | WP-D | P3 |
   | WP-E | P4 |

   Kết quả WP-F đưa vào A, D, E.
3. **Gộp**: áp patch theo thứ tự A, B, C, D, E; chạy test; chạy live; cập nhật docs; báo cáo.
4. **P5 (v35)**: làm một vòng riêng sau khi v34 đã gộp và chạy live xong.
5. **Sau khi plan được duyệt**: cập nhật memory `no-tools-that-conflict-with-engine` với ngoại lệ reflection cho member internal của Editor.

## Kiểm chứng

1. **Kiểm tĩnh**
   - `npm test`;
   - `dotnet build test/flax-api-smoke/BridgeCompileSmoke.csproj`, 0 warning;
   - v35 thêm smoke compile bản game.
2. **Chạy Editor thật trên bản sao TestFlax**, theo quy trình trong memory `flax-live-verification-setup`; gọi tool bằng `flax-mcp call` hoặc `dispatchToolCall`.
   - **P1**
     - Import 3 file theo lô: `ResultAssetId` khác null và khớp ID trong header.
     - `replace` giữ nguyên ID (nếu probe cho phép làm).
     - Gọi `ping` nhận `METHOD_NOT_FOUND` kèm danh sách method.
     - Mở hai Editor trên cùng bản sao: Editor thứ hai vào standby; tắt Editor thứ nhất thì Editor thứ hai nhận quyền.
     - `list_assets` offline in GUID khớp `asset_get`.
   - **P2**
     - `editor_launch` → `editor_get_status wait_ready` → `editor_quit` với từng giá trị `unsaved`.
     - Quit trong play mode.
     - `editor_options` tắt rồi bật lại auto-compile, trả giá trị về như cũ.
   - **P3**
     - Sửa field trong file scene trên đĩa, `reload` rồi đọc lại thấy giá trị mới.
     - `replace` đóng các scene khác.
     - Ghi field lồng nhau và asset ref trên script, save, mở lại vẫn còn; `edit_undo` trả lại giá trị cũ.
   - **P4**
     - Dựng zombie graph, play đổi `State` và thấy chuyển state.
     - Smoke X3.
   - **P5**
     - `build_cook` Development, `game_launch` 2 instance, chạy invoke/set/capture/log/quit trên từng instance.
     - Bản cook Release không chứa type của bridge runtime.
3. **Ghi kết quả** vào `docs/TESTING.md`; báo cáo; chờ bạn quyết định commit.

## Ngoài phạm vi

- Giả lập input thật: engine không bind `OnKeyDown`/`OnMouseDown` sang C#.
- Lỗi `LNK1104` của hot reload native: thuộc engine/project. MCP chỉ cung cấp vòng quit → build → launch → chờ sẵn sàng.
- `Game.Gen.*`: việc của repo flax-test (Flax.Build sinh lại mỗi lần build; có thể bỏ track). Không đụng tới trong đợt này.
- Capture với kích thước tùy chọn.
- Mảng/list trong `path` lồng nhau.
- Vendor v34/v35 vào `flax-test/Source/Game/MCP/FlaxMcpBridge.cs`: làm sau, bằng patch giữ khối `PROJECT-LOCAL` (như D13 của weather plan), và hỏi trước.
- Các mục còn mở ở `docs/PLAN_BRIDGE_V33_FOLLOWUP.md` §5 không nêu ở đây.

## Kết quả v34 (2026-10-03)

Bridge v34, server 1.12.0, 175 tool. `npm test` 481 test (477 pass, 4 skip, 0 fail); `BridgeCompileSmoke` và `VisjectGraphApiCompileProbe` 0 warning. Chưa commit.

Cách làm: WP0 (khung) và WP-F (probe live) chạy trước; sau đó A, A2, B, C, D, E1, E2 chạy song song trên bản sao working tree và trả về patch; cuối cùng một vòng chạy Editor thật trên bản sao TestFlax. WP-D và WP-E ban đầu chạy trên Opus, dừng giữa chừng vì hết hạn mức tuần, nên được làm lại bằng Sonnet (WP-E tách thành E1 và E2).

| Hạng mục | Kết quả |
|---|---|
| P1 import | `ResultAssetId` khớp ID trong header; `replace` giữ ID, đổi kiểu thì bị từ chối; `items[]` chạy theo lô |
| P1 method lạ | `METHOD_NOT_FOUND` kèm `Methods`; `status.Methods` |
| P1 nhiều Editor | Editor thứ hai vào standby; nhận quyền sau khoảng 2 s (khi PID chết) đến 17 s (khi quit sạch) |
| P1 GUID | Reader offline in dạng "N" khớp `asset_get`; FLAX002 hết báo sai |
| P2 vòng đời | `editor_launch`, `editor_get_status wait_ready`, `editor_quit` (refuse/save/discard, quit lúc play), `editor_options` (file option khôi phục giống từng byte), CLI `flax-mcp call`/`tools` |
| P3 scene/member | Sửa file scene trên đĩa rồi `reload` thấy giá trị mới; `replace`; asset ref và field lồng nhau trên script lưu được, `edit_undo` đúng |
| P4 graph | Dựng đủ zombie graph (Multi Blend 1D, Attack/Hit/Dead, transition có rule `State == n`, Any→Dead); play đổi `State`/`Speed` thấy chuyển pose |
| X3 | Material, MaterialFunction, module particle qua `graph_edit`, GameplayGlobals với biến |

Lỗi tìm thêm và đã sửa:
- **Từ probe**: `Content.GetAssetInfo`/`LoadAsync` với đường dẫn viết khác kiểu làm Flax đổi ID asset. Chỗ dính: `material.create_instance`, nhánh dự phòng load model, `Content.RenameAsset`. Đây khả năng cao là nguồn gốc vụ "ID …4133…" của flax-test.
- **Từ probe**: `navigation.build` truyền timeout như độ trễ khởi động.
- **Từ vòng live**: bridge không khởi động được vì game assembly không có `System.Diagnostics.Process` (đổi sang kernel32 hoặc `/proc`); P/Invoke không blittable; navmesh headless quá nhanh nên poll bỏ lỡ; `graph_edit` nối từ Get Parameter mới tạo; module particle ở root của emitter; `bridge.json` vắng mặt trong chốc lát lúc `File.Replace`.

Còn mở:
- Chưa có tool đọc giá trị GameplayGlobals.
- `graph_inspect` không liệt kê context transition; dùng `existing_nodes` của `graph_list_archetypes`.
- Tín hiệu "completed" của navmesh là suy luận khi build quá ngắn.
- `code_compile` có thể trả `EDITOR_BUSY`/`TIMEOUT` khi Editor đang tự compile.
- Hai Editor cùng project mà source thay đổi có thể kẹt compile.
- Giới hạn `order` của transition: Node cho ±1024, bridge cho ±1.000.000.
- `mm_apply_preset` (và `src/tools/mmTuning.ts`) là tool riêng của game: đã gỡ, còn 177 tool.

## Kết quả v35 (2026-10-03)

Server 1.13.0, 178 tool (sau đó gỡ `mm_apply_preset`, còn 177). Bridge Editor giữ v34; bridge runtime mới là v35 (`bridge/FlaxMcpRuntimeBridge.cs`). `npm test` 537 test (533 pass, 4 skip, 0 fail). Ba compile smoke 0 warning: Editor, runtime Development, runtime Release. Bản Release biên dịch ra assembly rỗng. Chưa commit.

Cách làm: R1 (file C#) và R2 (phía Node) chạy song song theo `v35_contract`, gộp trên một bản sao tích hợp, rồi một vòng chạy live trên bản cook Windows Development và Release của bản sao TestFlax.

| Hạng mục | Kết quả |
|---|---|
| Cài đặt | `install_editor_bridge include_runtime` cài cả hai file; báo hash từng file |
| Cook | `build_cook` trong Editor chạy được cho Development và Release. Editor phải được mở với `DOTNET_ROOT` trỏ tới SDK 8 |
| An toàn | Bản Release không có type của bridge, bỏ qua `-mcpdir`; game chạy không có `-mcpdir` thì không tạo file nào |
| Hai instance | `game_launch` g1, g2; `game_list_instances` không lộ đường dẫn |
| Điều khiển | invoke (kết quả và exception trả như dữ liệu), set (gồm path lồng nhau, asset theo GUID), inspect, log, capture PNG 1280x720, perf, time scale |
| Từ chối | tên instance có ký tự đường dẫn, exe ngoài project, `-mcpdir` trong args, `force` với game không do server này launch, instance đã dừng (`GAME_NOT_CONNECTED`) |
| Dừng | quit sạch khoảng 0.3 s; `force` kill được game bị treo main thread |

Lỗi tìm thấy khi chạy live và đã sửa: `game_launch wait_ready` trả về trước khi scene đầu tiên load xong. Giờ nó chờ tối đa 10 s để có scene.

Còn mở:
- `perf_get_snapshot` của game trả `draw_calls`/`triangles` null.
- Response của game đặt phiên bản engine dưới key `editorVersion`.
- `force` không với tới game do một tiến trình server khác launch.
- Game mất focus chạy theo giới hạn FPS khi unfocused của project.
- Chưa chạy trên Linux/macOS.
