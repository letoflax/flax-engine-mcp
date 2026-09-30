# Kế hoạch hoàn thiện sau bridge v33

> Điểm xuất phát: commit `bbb657c` (bridge v33, server 1.11.0, 170 tool).
> Không commit gì trong đợt này khi chưa hỏi. Không tăng số tool nếu mở
> rộng tool sẵn có là đủ; giữ bridge v33 vì v33 chưa phát hành.

## 1. Việc cần làm

| Gói | Nội dung | Người làm |
|---|---|---|
| A | 13 phát hiện còn mở của code review về import settings (v32): reimport bằng default khi không khôi phục được options, phân loại nhầm `TextureBase`, khoảng giá trị rộng hơn engine, NaN, tràn số nguyên, mã lỗi sai, `asset_get` báo sai khả năng, operation treo `running`, schema `settings` không có kiểu | Opus |
| B | Giới hạn của tool v33: kiểu `IBrush` và `FontReference` cho UI, tham chiếu asset của engine | Opus |
| C | `test_run_scenario` gọi được tool runtime giữa chừng; cập nhật MCP prompts; `actor_set_property` trả `HEADLESS_MODE` khi headless; gom hằng số phiên bản trong test và `serverStatus.ts` (phát hiện 15) | Sonnet |
| D | Rà soát tài liệu so với code và sửa chỗ lệch: `README.md`, `bridge/PROTOCOL.md`, `docs/TESTING.md`, các file plan | Sonnet |
| E | Chạy Editor thật cho bản đã gộp: import settings, UI brush/font, asset engine, `particle_set_parameter` với tham số thật, nhánh từ chối khi cửa sổ settings đang mở, và hồi quy | Opus |

## 2. Cách chạy song song

A, B, C làm trên ba bản sao riêng của working tree (thư mục thường, không
có `.git`, nên không thể commit nhầm). D sửa tài liệu ngay trên repo vì
không gói nào khác đụng tới tài liệu.

| Gói | File được sửa |
|---|---|
| A | vùng import settings của `bridge/FlaxMcpBridge.cs`, `src/tools/assetImport.ts`, `src/tools/assetImport.test.ts`, test hợp đồng mới |
| B | vùng member/UI của `bridge/FlaxMcpBridge.cs`, `src/tools/memberLive.ts`, `src/tools/liveToolSupport.ts`, phần mô tả giá trị trong `src/tools/editorLive.ts`, test mới |
| C | `src/tools/testScenario.ts`, `src/prompts.ts`, `src/tools/editorLive.ts` (ánh xạ lỗi), `src/tools/serverStatus.ts`, `src/bridge/bridgeV7Contract.test.ts` và test liên quan |
| D | `README.md`, `bridge/PROTOCOL.md`, `docs/*.md`, `test/compatibility-matrix.json` |

Không gói nào sửa `package.json`. A, B, C không sửa tài liệu mà trả về
"docs delta" để gộp sau.

## 3. Gộp và kiểm chứng

1. Lấy patch của từng bản sao so với bản gốc, áp vào repo theo thứ tự A, B, C.
2. Thêm file test mới vào `package.json`; chạy `npm test` và
   `dotnet build test/flax-api-smoke/BridgeCompileSmoke.csproj`.
3. Gói E chạy Editor thật trên project dùng-một-lần, sửa lỗi tìm thấy, ghi
   kết quả vào `docs/TESTING.md`.
4. Áp docs delta của A, B, C và E lên kết quả của D.
5. Báo cáo; chờ bạn quyết định commit.

## 4. Ngoài phạm vi

Giả lập input thật, `terrain_paint`, `animation_set_graph_parameter` (engine
không có API), transaction/rollback, CI, Linux/macOS.

## 5. Kết quả (2026-09-30)

Cả năm gói đã xong và đã gộp vào working tree; chưa commit. Bản gộp:
`npm test` 367 test (363 pass, 4 skip, 0 fail), compile smoke 0 warning,
bridge v33, server 1.11.0. Số tool giảm từ 170 xuống 169 vì `mm_tuning` bị gỡ
(xem mục 6). Chi tiết lần chạy Editor thật nằm ở mục
"Bridge v33 follow-up live run" của `docs/TESTING.md`.

| Gói | Kết quả |
|---|---|
| A | Sửa 12 phát hiện (2–13), phát hiện 14 sửa một phần. Ghi import settings bị từ chối khi không khôi phục được options hiện tại; chỉ nhận đúng `Texture`, `Model`, `SkinnedModel`, `AudioClip`; khoảng giá trị theo engine; reimport không xếp hàng được thì lỗi ngay; gọi lại `operation_id` cũ trả đúng kết quả lần đầu (`adopted:true`). Không làm: gộp DTO và gộp ba hàm restore/project/mutate (phát hiện 14) |
| B | Member kiểu asset nhận `engine:<path>`; member `IBrush` nhận chuỗi `<kind>:<value>[;option=value]` (9 loại của brush picker, trừ `GPUTextureBrush`); `FontReference` nhận `<font>;size=<points>`. Giá trị đọc ra dùng lại được làm giá trị ghi |
| C | `test_run_scenario` có `steps` (`set_script_value`, `invoke_script_method` với `expect`); 5 prompt viết lại theo tool hiện có; hằng số phiên bản bridge gom về một chỗ |
| D | Sửa các chỗ tài liệu lệch code; các lỗi code nó phát hiện đã sửa sau khi gộp (`animgraph_set_state_clip` bị đánh dấu read-only, resource subscription bỏ sót tool ghi mới, nhãn audit sai, mô tả `reimport_asset`/`actor_update`, tên file request chỉ ASCII) |
| E | Chạy lại toàn bộ trên Editor thật. Tìm và sửa hai lỗi: tool material/graph/play-start báo `EDITOR_BUSY` hoặc `INVALID_PLAY_STATE` khi Editor headless từ chối (giờ là `HEADLESS_MODE` cho mọi tool); mỗi lần `asset_create` nhị phân làm engine ghi lỗi "duplicated asset ID" |

Chưa xử lý, ghi lại để quyết định sau (đều ngoài phạm vi đợt này):

- Capture editor viewport báo `completed` với ảnh trong suốt khi tab Game
  đang che tab Edit; `size_bytes` của capture đôi khi sai.
- Lệnh gọi đúng lúc Editor tự recompile bridge trả `INTERNAL_ERROR` (token
  phiên đổi giữa chừng) thay vì một mã cho biết nên thử lại.
- `material_create_instance` kiểm tra trùng trong registry bằng đường dẫn
  tương đối nên không bao giờ khớp (kiểm tra `File.Exists` bên cạnh vẫn chặn
  được).
- Vài tool ghi `changes` cho thao tác không đổi gì (`scene_open` khi scene đã
  mở, `play_stop` khi đã dừng, poll một lần ghi import settings no-op).
- Chưa chạy thật: tham số particle kiểu asset, brush không có dạng chuỗi,
  `restored:false` cho Model/AudioClip, Linux/macOS.

## 6. Quyết định sau khi báo cáo

- Gỡ tool `mm_tuning`: MCP chỉ nên chứa tool tổng quát thao tác với engine,
  còn `mm_tuning` là tool riêng cho hệ motion matching của một game. Op
  `rebuild_start` của nó (việc ghi duy nhất mang nhãn "chỉ đọc") đi theo.
  `mm_apply_preset` cùng loại nhưng chưa được yêu cầu gỡ nên còn nguyên.
- Profile `scene-edit` giữ nguyên: vẫn gồm `build_cook`, `build_cancel` và
  các tool bake.
- Các phát hiện ở cuối mục 5 chưa làm.
