# GUID audit P7 — Model/Material text refs vs .flax headers (READ-ONLY REPORT)

> Status (2026-09-30): historical record of a one-off read-only audit; it is not maintained and its counts describe the scene files of that date. The scenes it examines belong to external projects, not to this repository. The bridge's registry/file ID guard (`registry/file ID mismatch`, `ASSET_OPERATION_FAILED`, in `bridge/FlaxMcpBridge.cs`) cites this report; current bridge behaviour is documented in `bridge/PROTOCOL.md`.

Date: 2026-09-26. No file under `D:\Code\flax\flax-test\` was written or modified;
flax-test `Content/Scenes/*.scene` bytes were only read as a fallback comparison.
Primary source is the playback copies
`D:\Code\flax\flax-playback\Content\Scenes\WeaponTestScene.scene` and
`D:\Code\flax\flax-playback\Content\Scenes\PlayerTestScene.scene`.
This report fixes nothing; it classifies only.

## Method (header bytes)

Each `Content/**/*.flax` header stores a 16-byte asset GUID at byte offset 28:
`Data1` LE uint32 + `Data2` LE uint16 + `Data3` LE uint16 + `Data4` raw 8 bytes
(magic `CFWF`, e.g. AR15 header `36 b2 fb a2 c2 10 33 41 ab e2 53 a0 c8 d1 83 9c`).

- managed-form (bridge/`asset.get`, .NET `Guid.ToString("N")`):
  `Data1 + Data2 + Data3 + Data4` straight from the header.
- native-form (scene/prefab text, engine `Register asset` log):
  `Data1 + Data3 + Data2 + reverse(Data4[0:4]) + reverse(Data4[4:8])`
  (Data2<->Data3 swapped, each Data4 half byte-reversed).

Verified on the AR15 case from `flax-test/docs/SCENE_SAVE_FIELD_LOSS.md` § correction:

| asset | header-derived managed | header-derived native | scene text |
|---|---|---|---|
| `Content/Weapons/AR15/AR15.flax` | `a2fbb23610c24133abe253a0c8d1839c` | `a2fbb236413310c2a053e2ab9c83d1c8` | native MATCH |
| `Content/Weapons/AR15/ar15/AR15.flax` | `a68b84527311411d89970aab3dd3e5b4` | `a68b8452411d7311ab0a9789b4e5d33d` | native MATCH |
| `Content/Weapons/AR15/ar15/Magazine.flax` | `d01e6c578666406faa042b6db4b49c1b` | `d01e6c57406f86666d2b04aa1b9cb4b4` | native MATCH |

Rule (per that doc): hand-written `.scene`/`.prefab` GUIDs must use native-form
(`Register asset` log); bridge/C# keeps using managed-form. A managed-form GUID
in scene text loads only via the bridge path and is fragile; a GUID matching
neither header form never resolves.

Scope: keys `Model`, `Material`, `SkinnedModel`, `PlayerModel` only.
`CharacterBody` values are actor IDs (equal to the sibling `Mannequin` actor ID
in each scene), not asset refs — excluded. `CustomTexture`
`c54410104ff39427bc11e5bc761d66b0` is a texture ref with no `.flax` header match
in either Content tree — noted but out of Model/Material scope.

Indexed: 913 `.flax` files under `D:\Code\flax\flax-playback\Content`
(same count under `D:\Code\flax\flax-test\Content`).

## WeaponTestScene (playback copy, 31 refs / 5 unique)

| ref | key(s) | x | classification | header match |
|---|---|---|---|---|
| `089f804c41445c56d2817f9ddd61a472` | Material | 14 | native-form correct | `Content/Materials/M_Grid.flax` |
| `089f80440d8653f4f23a2ef01a9749fa` | SkinnedModel, PlayerModel | 2 | native-form correct | `Content/Models/Mannequin.flax` |
| `b43f0f8f4aaba3f3156896a5a22ba493` | Model | 14 | neither (no header match) | none in either Content tree; counterpart `b43f0f8fa3f34aaba596681593a42ba2` also absent — likely engine built-in primitive, unverified |
| `92ff424941e625f2045d49a1616ec3b8` | Material | 1 | neither (no header match) | none; counterpart `92ff424925f241e6a1495d04b8c36e61` also absent — mannequin body material file missing or renamed |

Counts: native-correct 16 / managed-fragile 0 / neither-broken 15 (14 Model + 1 Material).
Zero managed-form refs in the playback copy.

## PlayerTestScene (playback copy, 7 refs / 5 unique)

| ref | key(s) | x | classification | header match |
|---|---|---|---|---|
| `089f804c41445c56d2817f9ddd61a472` | Material | 2 | native-form correct | `Content/Materials/M_Grid.flax` |
| `089f80440d8653f4f23a2ef01a9749fa` | SkinnedModel, PlayerModel | 2 | native-form correct | `Content/Models/Mannequin.flax` |
| `b43f0f8f4aaba3f3156896a5a22ba493` | Model | 2 | neither (no header match) | same as above |
| `92ff424941e625f2045d49a1616ec3b8` | Material | 1 | neither (no header match) | same as above |

Counts: native-correct 4 / managed-fragile 0 / neither-broken 3 (2 Model + 1 Material).

## Fallback comparison (flax-test read-only)

`D:\Code\flax\flax-test\Content\Scenes\PlayerTestScene.scene` is identical in
Model/Material refs to the playback copy (same 5 unique, same verdicts).

`D:\Code\flax\flax-test\Content\Scenes\WeaponTestScene.scene` has 3 extra refs
absent from the playback copy (28 refs / 8 unique there vs 31 refs / 5 unique
in playback — playback uses the `b43f0f8f` placeholder where flax-test binds AR15):

| ref | key | classification |
|---|---|---|
| `a2fbb236413310c2a053e2ab9c83d1c8` | Model (Visual) | native-form correct (`AR15.flax`) |
| `a68b8452411d7311ab0a9789b4e5d33d` | Material | native-form correct (`ar15/AR15.flax`) |
| `d01e6c57406f86666d2b04aa1b9cb4b4` | Material | native-form correct (`ar15/Magazine.flax`) |

All three are native-form correct per the table above. The playback copy is
therefore stale relative to the flax-test AR15 bind (expected: playback was
left clean after scratch bind/undo cycles per `SCENE_SAVE_FIELD_LOSS.md`).

## Totals (playback copies, Model/Material/SkinnedModel/PlayerModel)

- refs examined: 38 (31 Weapon + 7 Player); unique GUIDs: 5.
- native-form correct: 20 refs (16 Weapon + 4 Player) / 2 unique.
- managed-form fragile (bridge-only): 0 refs / 0 unique.
- neither (broken/unresolved, no `.flax` header match): 18 refs / 2 unique
  (`b43f0f8f…` Model x16, `92ff4249…` Material x2).

No managed-form scene refs were found; no fix was applied. The two
`neither` GUIDs deserve a follow-up outside this task: confirm whether
`b43f0f8f…` is an engine built-in primitive (safe) and locate or reimport the
`92ff4249…` body material.

## Verification limit

Header parsing was done with a throwaway Python reader (offset 28, struct
`<IHH` + raw Data4) cross-checked against the three AR15 engine-log GUIDs;
`flax-test` files were opened read-only and are unmodified
(`git -C D:/Code/flax/flax-test status` untouched by this task — no write
surface was used there).
