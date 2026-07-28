# Bug — `install_editor_bridge` cài vào module không tồn tại

> ## ✅ ĐÃ SỬA — 2026-07-28
>
> Bug này **không còn** trong bản hiện tại. Giữ tài liệu làm hồ sơ lịch sử và làm ca kiểm thử tham chiếu.
>
> Xác minh bằng cách **chạy thật** trên chính project từng dính lỗi (`LetoACS/SampleProject`, module `Sample`):
>
> ```jsonc
> // get_editor_bridge_installation
> { "target": "Source/Sample/MCP/FlaxMcpBridge.cs", "module": "Sample", ... }
>
> // install_editor_bridge  → action: "create"
> { "changes": [ { "kind": "file.created", "path": "Source/Sample/MCP/FlaxMcpBridge.cs" } ] }
> ```
>
> Đường dẫn không còn cố định cứng: `install_editor_bridge` và `get_editor_bridge_installation` nay dò
> module thật và nhận thêm tham số tuỳ chọn `module` cho trường hợp Editor target có nhiều module mơ hồ.
> Mô tả tool cũng đổi thành *"installs the bundled Editor Bridge in a detected Flax game module"*.
>
> Kiểm chứng hạ nguồn: file cài ra **biên dịch được** (`tools/build.ps1 sample` xanh trên `LetoACS`), tức
> là nó thật sự nằm trong một module được target dựng — đúng điều kiện mà §4 nói là bị trượt.
>
> Phần còn lại của tài liệu mô tả trạng thái **trước** khi sửa.

> **Trạng thái lúc viết:** đã xác minh bằng phân tích tĩnh, **chưa** chạy thử installer (xem §9).
> **Phát hiện:** 2026-07-28, trong lúc thử dùng bridge v6 cho project `LetoACS`.
> **Phiên bản quan sát:** `flax-engine-mcp` @ `1df4be7` (v1.3.0, working tree có thay đổi chưa commit), bridge v6 / protocol v1.
> **File liên quan:** `src/tools/bridgeInstaller.ts`, `README.md`.

---

## 1. Tóm tắt

`install_editor_bridge` ghi Editor Bridge vào một đường dẫn **cố định cứng** là
`Source/Game/MCP/FlaxMcpBridge.cs`. `Source/Game` là tên module **mặc định của template Flax**, không phải
một hằng số của engine. Với project đặt tên module khác — trường hợp `LetoACS` dùng module `Sample` —
đường dẫn đó nằm ngoài mọi module, nên Flax.Build **không biên dịch** file vừa cài. Bridge không bao giờ
khởi động, không có heartbeat, và toàn bộ nhóm tool v5/v6 (scene/actor live, compile, play, log, capture,
runtime inspect) đứng ở chế độ offline vĩnh viễn.

Điểm khiến lỗi này đắt hơn bình thường: **installer vẫn báo thành công**. Không có bước nào trong chuỗi
báo lỗi. Người dùng nhận `success`, `installed.present: true`, `current: true`, rồi đi tìm nguyên nhân ở
heartbeat, token, hay protocol — trong khi nguyên nhân nằm ở hệ thống module, một tầng hoàn toàn khác.

---

## 2. Môi trường quan sát

| | |
|---|---|
| MCP server | `flax-engine-mcp` v1.3.0, commit `1df4be7` |
| Bridge | `BridgeVersion = 6`, `ProtocolVersion = 1` |
| Engine | Flax 1.12.6912, `D:\Apps\Flax\Flax_1.12` |
| Project đăng ký với MCP | `D:\Code\flax\LetoACS\SampleProject` |
| Lệnh đăng ký | `claude mcp add flax -- node <...>\dist\index.js --project-path D:\Code\flax\LetoACS\SampleProject` |

`LetoACS` là repo **plugin**, không phải project game theo template. Nó có hai `.flaxproj`:

```
D:\Code\flax\LetoACS\LetoACS.flaxproj              # plugin, module: WeaponData/FireArm/Recoil/HitDamage/CombatNet/CombatTools
D:\Code\flax\LetoACS\SampleProject\...flaxproj     # composition root, module: Sample
```

---

## 3. Đường đi trong code

`src/tools/bridgeInstaller.ts:17`

```ts
const INSTALL_RELATIVE_PATH = 'Source/Game/MCP/FlaxMcpBridge.cs';
```

`src/tools/bridgeInstaller.ts:71-73`

```ts
function installTarget(ctx: ProjectMeta): string {
  return path.join(ctx.projectPath, ...INSTALL_RELATIVE_PATH.split('/'));
}
```

Hằng số này là đường dẫn **duy nhất** mà installer biết. Toàn bộ module không có bất kỳ đoạn nào đọc
layout thật của project — không quét `*.Build.cs`, không đọc `.flaxproj`, không tham số hoá theo module.
Nó xuất hiện ở năm chỗ và đều là cùng một giá trị:

| Vị trí | Vai trò |
|---|---|
| `:17` | khai báo hằng số |
| `:38` | `BridgeInstallationInfo.target` khai kiểu là `typeof INSTALL_RELATIVE_PATH` — đường dẫn bị neo vào **kiểu**, không chỉ vào giá trị runtime |
| `:72` | dựng đường dẫn tuyệt đối để ghi |
| `:95`, `:176`, `:194` | giá trị báo cáo ra ngoài và ghi vào audit |
| `:121` | trường `target` trong `.flax-mcp/bridge-install-audit.jsonl` |

`README.md:36` mô tả hành vi này như một đặc tả, không phải mặc định có thể đổi:

> `install_editor_bridge` — Preview or safely install the bridge at `Source/Game/MCP/FlaxMcpBridge.cs`

---

## 4. Vì sao file không được biên dịch

Flax.Build xác định module bằng sự tồn tại của file `*.Build.cs`, và target liệt kê tường minh những
module nó dựng. Một thư mục `.cs` không thuộc module nào thì không nằm trong bất kỳ đơn vị biên dịch nào —
nó không gây lỗi build, chỉ đơn giản là không tồn tại đối với compiler.

Layout thật của `SampleProject`:

```
SampleProject/Source/
├─ Sample/                      ← module, vì có Sample.Build.cs bên trong
│  ├─ Sample.Build.cs
│  ├─ AimDemo.cs
│  ├─ WeaponStackController.cs
│  └─ ...
├─ Sample.Gen.cs
├─ SampleEditorTarget.Build.cs  ← target, liệt kê module cần dựng
└─ SampleTarget.Build.cs
```

Không có `Source/Game`. Sau khi cài, cây thư mục thành:

```
SampleProject/Source/
├─ Game/
│  └─ MCP/
│     └─ FlaxMcpBridge.cs       ← không có Game.Build.cs → không phải module → không được biên dịch
└─ Sample/
   └─ ...
```

Hai điều kiện đều trượt, chỉ cần một là đủ hỏng:

1. `Source/Game/` không chứa `Game.Build.cs`, nên nó không được nhận diện là module.
2. Kể cả nếu có, `SampleEditorTarget.Build.cs` liệt kê module tường minh; một module không nằm trong danh
   sách đó vẫn không được dựng.

Lưu ý để tránh chẩn đoán nhầm: thư mục con `MCP/` **không** phải vấn đề. Flax biên dịch mọi `.cs` nằm dưới
thư mục module, kể cả lồng nhiều cấp. Nếu module tên `Game` có thật thì `Source/Game/MCP/FlaxMcpBridge.cs`
sẽ chạy đúng. Cái sai duy nhất là phân đoạn `Game`.

---

## 5. Chuỗi hậu quả quan sát được

1. `install_editor_bridge` ghi file thành công. `atomicWriteConfined` + `assertWritePathWithinRoot` đều
   qua, vì đường dẫn vẫn nằm trong project root — các guard an toàn không có lý do gì để chặn.
2. Audit `.flax-mcp/bridge-install-audit.jsonl` ghi một bản ghi `success: true`.
3. `get_editor_bridge_installation` đọc lại đúng đường dẫn vừa ghi, nên trả
   `installed.present: true`, `installed.version: "6"`, `current: true`.
4. Người dùng làm theo `README.md:141` — mở/khởi động lại Flax Editor và chờ biên dịch C#. Editor biên
   dịch xong, **không có lỗi nào**, vì file không thuộc đơn vị biên dịch nào.
5. Bridge không chạy `OnInit`, nên `Cache/MCP/` không được tạo. Không có `bridge.json`, không có `token`.
6. `editor_get_status` và `get_server_capabilities` không thấy heartbeat hợp lệ → báo offline mode.
7. Mọi tool cần bridge v5 trở lên (scene/actor live, script attach/detach) và v6 (`code_compile`,
   `play_*`, `log_query`, `capture_*`, `runtime_inspect_actor`) không dùng được.
8. `create_actor` / `modify_actor` vẫn chạy được vì chúng là đường legacy offline ghi thẳng file `.scene`
   — càng làm hệ thống trông như "vẫn hoạt động, chỉ thiếu phần live".

Đã kiểm chứng bước 5 ở trạng thái hiện tại:

```powershell
Test-Path 'D:\Code\flax\LetoACS\SampleProject\Cache\MCP'   # False
Get-ChildItem -Recurse D:\Code\flax\LetoACS -Filter "FlaxMcpBridge*"   # không có kết quả
```

---

## 6. Vì sao khó chẩn đoán

Hai hệ thống con đưa ra hai câu trả lời mâu thuẫn, và **không hệ nào sai theo logic riêng của nó**:

| Câu hỏi | Trả lời | Căn cứ |
|---|---|---|
| Bridge đã cài chưa? | rồi, và đúng bản mới nhất | file tồn tại tại `INSTALL_RELATIVE_PATH`, hash khớp bundled |
| Bridge đang chạy chưa? | chưa, offline | không có heartbeat ở `Cache/MCP/bridge.json` |

`inspectEditorBridgeInstallation` định nghĩa "đã cài" là **file có mặt tại đường dẫn đã biết**. Đó là định
nghĩa hợp lý cho một installer, nhưng nó không giao nhau với điều kiện thật sự cần: *file nằm trong một
module được target dựng*. Khoảng trống giữa hai định nghĩa chính là chỗ lỗi trú.

Hướng điều tra tự nhiên khi thấy "đã cài nhưng offline" là đi theo phần mới và phức tạp nhất: heartbeat,
token, so sánh constant-time, freshness, pid, protocol version — tức là `PROTOCOL.md`. Không có tín hiệu
nào chỉ về phía hệ thống module của Flax.Build. Người điều tra phải tự nghĩ ra giả thuyết "có thể file
không được biên dịch", mà giả thuyết đó chỉ nảy ra nếu đã biết trước project này không dùng module tên
`Game`.

Thêm một lớp gây nhiễu: `README.md:141` dặn "Restart/open Flax Editor and wait for C# compilation after
installation". Người dùng làm đúng, thấy biên dịch xong sạch sẽ, và hợp lý kết luận rằng bước cài đã hoàn
tất — trong khi việc biên dịch sạch ở đây chính là triệu chứng.

---

## 7. Phạm vi ảnh hưởng

Lỗi xảy ra với **mọi project không đặt tên module game là `Game`**. Không phải trường hợp hiếm:

- Repo plugin có SampleProject/TestProject riêng, module đặt theo tên sản phẩm (`LetoACS` → `Sample`).
- Project đổi tên module theo game.
- Project nhiều module, không có module nào tên `Game`.

Project sinh từ template Flax mặc định thì không dính, vì template đúng là tạo `Source/Game`. Nghĩa là lỗi
này **không xuất hiện trong thử nghiệm trên project template**, chỉ lộ ra trên project thật có cấu trúc
riêng.

Trong repo `LetoACS`, cả hai `.flaxproj` đều dính, không cái nào có module `Game`:

| `.flaxproj` | Module |
|---|---|
| `LetoACS.flaxproj` | `WeaponData`, `FireArm`, `Recoil`, `HitDamage`, `CombatNet`, `CombatTools` |
| `SampleProject.flaxproj` | `Sample` |

---

## 8. Cách tái hiện

```powershell
# 1. Đăng ký MCP với một project có module KHÔNG tên Game
claude mcp add flax -- node <repo>\dist\index.js --project-path D:\Code\flax\LetoACS\SampleProject

# 2. Xác nhận project không có Source/Game
Get-ChildItem D:\Code\flax\LetoACS\SampleProject\Source
#   Sample, Sample.Gen.cs, SampleEditorTarget.Build.cs, SampleTarget.Build.cs — không có Game

# 3. Gọi install_editor_bridge  → success
# 4. Gọi get_editor_bridge_installation → installed.present: true, current: true
# 5. Mở Flax Editor, chờ biên dịch xong → không lỗi
# 6. Gọi editor_get_status → offline
Test-Path D:\Code\flax\LetoACS\SampleProject\Cache\MCP   # False
```

---

## 9. Ranh giới của báo cáo này

Ghi rõ để không ai đọc mạnh hơn bằng chứng:

- **Đã xác minh:** hằng số `INSTALL_RELATIVE_PATH` và cách nó được dùng (đọc code); layout module thật
  của `SampleProject` (liệt kê thư mục); `Cache/MCP` chưa tồn tại; không có `FlaxMcpBridge.cs` nào trong
  `LetoACS`; `npm test` hiện tại **74/74 pass** — bộ test không bắt được trường hợp này.
- **Chưa xác minh bằng cách chạy thật:** chưa gọi `install_editor_bridge`, nên các bước 1–4 ở §5 là suy
  ra từ code chứ không phải quan sát. Nguyên nhân: tool MCP chưa nạp được vào session đang chạy (server
  được đăng ký giữa session, schema chỉ vào ở session sau).
- **Chưa xác minh:** hành vi chính xác của Flax.Build khi gặp thư mục `.cs` mồ côi — bài viết giả định nó
  bị bỏ qua im lặng, dựa trên quy tắc module qua `*.Build.cs`. Khả năng nó phát ra cảnh báo ở đâu đó chưa
  được loại trừ; nếu có cảnh báo thì mức độ khó chẩn đoán ở §6 giảm đi, nhưng kết luận không đổi.
- Báo cáo này **không** đề xuất cách sửa, theo yêu cầu.
