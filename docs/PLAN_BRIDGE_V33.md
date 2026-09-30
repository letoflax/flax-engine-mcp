# Kế hoạch bridge v33 — bổ sung các chức năng còn thiếu

> **Trạng thái (2026-09-30): đã triển khai** trong bridge v33 / server 1.11.0 (170 tool); giữ làm hồ sơ kế hoạch, kết quả nằm ở mục 5. Việc điều chỉnh sau v33 nằm ở `docs/PLAN_BRIDGE_V33_FOLLOWUP.md`. Mô tả hiện hành: `README.md`, mục "Bridge v33" của `bridge/PROTOCOL.md`, và `docs/TESTING.md` (lần chạy Editor thật).

> Phạm vi: sáu khoảng trống đã nêu khi rà soát MCP ở bridge v32 (152 tool).
> Nguồn kiểm chứng API: header C++ trong `Flax_1.12/Source` và bản decompile
> `FlaxEngine.CSharp.dll` (bản cài Flax 1.12 không kèm `.cpp` lẫn mã C# của
> Editor). Mọi call site mới được compile lại bằng
> `test/flax-api-smoke/BridgeCompileSmoke.csproj`.

## 1. Nguyên tắc: không tạo tool đi ngược engine

Một tool chỉ được thêm khi nó đi qua đúng đường mà Editor/engine tự dùng.
Các trường hợp dưới đây bị loại hoặc giữ nguyên stub:

| Đề xuất | Quyết định | Lý do |
|---|---|---|
| Giả lập phím/chuột (`input_key_press`, `input_mouse_click`) | Giữ stub `UNSUPPORTED_FLAX_VERSION` | `Keyboard::OnKeyDown`, `Mouse::OnMouseDown` không có `API_FUNCTION` (`Engine/Input/Keyboard.h`, `Mouse.h`). Đường vòng gọi `RootControl.GameRoot.OnMouseDown` chỉ tới GUI, còn `Input.GetKey`/vị trí chuột thật không đổi, nên state engine và state UI lệch nhau. |
| Ghi state actor lúc đang play | Không làm | Play mode do engine sở hữu state (physics, animation ghi đè mỗi frame). Chỉ cho ghi field/gọi method của **script game**. |
| Ghi `Name`, `IsActive`, transform, `Layer` qua đường generic | Không làm | Đã có `actor_update` với kiểm tra riêng; hai đường ghi cùng một field dễ lệch. |
| Ghi member `[HideInEditor]`, `[ReadOnly]`, `[NoSerialize]` lúc edit | Không làm | Editor không hiển thị hoặc không lưu các member này; ghi vào sẽ mất khi save/reload. |
| `terrain_paint`, `animation_set_graph_parameter` | Giữ stub | Không có API managed đã kiểm chứng. |
| Đặt control thuộc `FlaxEditor.*` vào scene | Từ chối | Kiểu chỉ tồn tại trong Editor, game đã cook sẽ không load được. |
| Sửa settings khi cửa sổ settings đó đang mở | Từ chối (`EDITOR_BUSY`) | Cửa sổ giữ bản sao riêng và sẽ ghi đè khi người dùng bấm Save. |

## 2. Tool mới (152 → 170)

### 2.1 Property actor tổng quát
- `actor_get_properties` (read): liệt kê member mà property grid hiển thị.
  Quy tắc chọn member chép từ `GenericEditor.GetItemsForType`.
- `actor_set_property` (mở rộng): ngoài 5 alias cũ, nhận `Member` hoặc
  `Type.Member`; thêm `dry_run`. Ghi qua `ScriptMemberInfo.SetValue` (đúng
  wrapper của property grid) bên trong một undo action của bridge.
- Kiểu hỗ trợ: bool, số, string, enum (kể cả `[Flags]`), Guid, Vector/Float/
  Double/Int 2-4, Color, Quaternion, Rectangle, Margin, LocalizedString,
  LayersMask, tham chiếu Asset, `JsonAssetReference<T>`, tham chiếu Actor/Script.

### 2.2 Điều khiển gameplay khi đang play
- `runtime_set_script_value`: ghi một member của script (kiểu không thuộc
  `FlaxEngine.*`), không undo, không đánh dấu scene edited.
- `runtime_invoke_script_method`: gọi một method public, không generic, tối đa
  4 tham số kiểu vô hướng, khai báo trong code game. Exception của game được
  trả về như dữ liệu (`Threw`), không phải lỗi tool.

### 2.3 Ghi settings (qua `GameSettings.Load/Save/Apply`)
- `settings_set_input_action`, `settings_set_input_axis`,
  `settings_remove_input_mapping`
- `settings_set_layer_name`, `settings_add_tag`, `settings_set_first_scene`
- Bridge mặc định `DryRun=true`; tool phía Node mặc định `dry_run:false` nhưng từ chối lời gọi thiếu cả `dry_run:true` lẫn `confirm:true`. Ghi thật cần `confirm:true` vì không có undo.

### 2.4 Vòng đời scene và content
- `scene_create` (`SceneModule.CreateSceneFile`), `scene_close`
  (`ChangingScenesState.UnloadScene`, không hiện hộp thoại)
- `content_create_folder`
- `asset_create`: asset nhị phân theo tag của `Editor.CreateAsset`, hoặc JSON
  asset theo tên kiểu qua `Editor.SaveJsonAsset`.

### 2.5 UI và particle (audio dùng chung 2.1)
- `ui_control_create`, `ui_control_get_properties`, `ui_control_set_property`
- `particle_get_parameters`, `particle_set_parameter`
- Audio: `AudioSource.Clip`, `Volume`, `IsLooping`... ghi bằng
  `actor_set_property`, không cần tool riêng.

### 2.6 Progress notification (chỉ phía Node)
- Khi client gửi `_meta.progressToken`, các vòng poll (compile, generate
  project, play, import, build, capture) và mọi RPC chờ lâu gửi
  `notifications/progress`. Giá trị `progress` là mili-giây đã trôi qua nên
  luôn tăng, đúng yêu cầu của spec.

## 3. Phân quyền

| Family | Tool mới |
|---|---|
| read | `actor_get_properties`, `ui_control_get_properties`, `particle_get_parameters` |
| scene | `ui_control_create`, `ui_control_set_property`, `particle_set_parameter`, `scene_close` |
| runtime | `runtime_set_script_value`, `runtime_invoke_script_method` |
| asset | 6 tool `settings_*`, `scene_create`, `content_create_folder`, `asset_create` |

## 4. Kiểm chứng

1. `dotnet build test/flax-api-smoke/BridgeCompileSmoke.csproj` — toàn bộ
   bridge compile với `FlaxEngine.CSharp.dll` thật.
2. `npm test` — contract, marshalling DTO, cổng phiên bản, phân quyền.
3. Chạy Editor thật trên bản sao project dùng một lần (không đụng project
   đang mở). Kết quả ghi vào `docs/TESTING.md`.

## 5. Kết quả triển khai (2026-09-30)

Toàn bộ mục 2 đã có trong bridge v33 và server 1.11.0. Chạy thật trên Flax
1.12.6912 (chi tiết ở `docs/TESTING.md`) phát hiện và sửa thêm:

| Phát hiện khi chạy Editor thật | Xử lý |
|---|---|
| `Width`, `Height`, `LocalX`, `LocalY`, `AnchorPreset`, `AnchorMin/Max`, `Offsets` của control mang `[HideInEditor]` vì Editor sửa chúng bằng `UIControlControlEditor` riêng | Cho phép đúng tập member đó trên control; phần còn lại vẫn theo quy tắc property grid |
| Property grid kẹp số theo `[Limit]`/`[Range]` | Từ chối giá trị ngoài khoảng thay vì ghi giá trị Editor không bao giờ tạo ra |
| Asset nhị phân mới chưa có trong registry ngay sau khi tạo | Đọc ID từ header file |
| `script_attach`/`actor_create` với kiểu của game ném `NullReferenceException` sau mỗi lần recompile: `AppDomain.GetAssemblies()` trả cả assembly của scripting context đã unload | Dùng `FlaxEngine.Utils.GetAssemblies()` |
| 11 tool truy vấn domain v14 (`physics_*`, `navigation_*`, `lighting_get_status`, `lighting_validate`, `terrain_get_summary`, `foliage_get_summary`) trả `{}`: `FlaxEngine.Json` không serialize anonymous type | Đổi sang DTO có tên, giữ nguyên tên field |
| Chi tiết lỗi (ví dụ `CurrentSceneRevision`) và fingerprint idempotency cũng là anonymous type nên rỗng | `PlainForJson` chuyển sang dictionary trước khi serialize |

## 6. Chưa làm

- Giả lập input thật: cần engine bind `OnKeyDown`/`OnMouseDown` sang C#.
- Transaction/rollback nhiều bước: vẫn là lease, không phải transaction.
- CI (`.github/`) và ma trận Linux/macOS.
