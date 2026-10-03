import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MEMBER_VALUE_SHAPES } from '../tools/liveToolSupport.js';

// Source-level contract for the member kinds added after bridge v33 shipped:
// GUI brushes, font references, and engine-content asset references. The
// behaviour itself was run against a real Flax 1.12 Editor; these checks pin
// the rules that must not drift.
const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

/** Returns the body of one C# method, from its signature to the next member at the same indent. */
function method(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `bridge must declare ${signature}`);
  const end = source.indexOf('\n        }\n', start);
  assert.notEqual(end, -1, `bridge method ${signature} must be closed`);
  return source.slice(start, end);
}

test('member kinds cover brushes and font references without widening the wire shape', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*34/);
  const kinds = method(source, 'private static string MemberKindName(Type type)');
  assert.match(kinds, /if \(IsBrushType\(type\)\) return "brush";/);
  assert.match(kinds, /if \(type == typeof\(FontReference\)\) return "font";/);
  assert.match(source, /typeof\(FlaxEngine\.GUI\.IBrush\)\.IsAssignableFrom\(type\)/);
  // Coercion still takes exactly one of Bool, Number, or Text.
  const coerce = method(source, 'private static object CoerceMemberValue(Type type, bool? boolValue, double? number, string text, string memberName)');
  assert.match(coerce, /requires exactly one of Bool, Number, or Text/);
  assert.match(coerce, /if \(IsBrushType\(type\)\) return CoerceBrushValue\(type, text, need, memberName\);/);
  assert.match(coerce, /if \(type == typeof\(FontReference\)\) return CoerceFontValue\(text, need, memberName\);/);
  // The request DTO gained no field for these kinds.
  assert.match(source, /public class McpActorPropertySet \{ public string ActorId; public string Property; public string\[\] Path; public bool\? Bool; public double\? Number; public string Text; public bool DryRun; public long\? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; \}/);
});

test('brush strings build only the brush types the Editor picker offers and a scene serializes', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /FlaxEditor\.CustomEditors\.Editors\.IBrushEditor/);
  const list = /BrushKindList = "([^"]+)"/.exec(source);
  assert.ok(list, 'bridge must declare BrushKindList');
  const kinds = list[1].split(', ');
  assert.deepEqual(kinds, ['solid', 'gradient', 'texture', 'texture9', 'sprite', 'sprite9', 'material', 'ui_brush', 'video']);
  const coerce = method(source, 'private static object CoerceBrushValue(Type type, string text, string need, string memberName)');
  for (const kind of kinds) {
    assert.ok(coerce.includes(`string.Equals(kind, "${kind}", StringComparison.Ordinal)`), `CoerceBrushValue must parse ${kind}`);
    // The Node schema documents every kind the bridge parses.
    assert.ok(MEMBER_VALUE_SHAPES.includes(`"${kind}:`), `MEMBER_VALUE_SHAPES must document ${kind}`);
  }
  for (const type of ['SolidColorBrush', 'LinearGradientBrush', 'TextureBrush', 'Texture9SlicingBrush', 'SpriteBrush', 'Sprite9SlicingBrush', 'MaterialBrush', 'UIBrush', 'VideoBrush']) {
    assert.ok(coerce.includes(`new FlaxEngine.GUI.${type}`), `CoerceBrushValue must construct ${type}`);
  }
  // A runtime GPU texture is not an asset: never constructed, refused with the reason.
  assert.doesNotMatch(source, /new FlaxEngine\.GUI\.GPUTextureBrush/);
  assert.match(coerce, /GPUTextureBrush is not available: it holds a runtime GPU texture, not an asset\./);
  // "" clears; anything else must name a kind and respect the member type.
  assert.match(coerce, /if \(text\.Length == 0\) return null;/);
  assert.match(coerce, /if \(!type\.IsInstanceOfType\(brush\)\)/);
  // Options are validated, never ignored.
  const split = method(source, 'private static string SplitValueFields(string body, string label, string[] allowed, out Dictionary<string, string> options)');
  assert.match(split, /has an unknown option/);
  assert.match(split, /repeats the option/);
  assert.match(source, /filter must be \\"linear\\" or \\"point\\"/);
  assert.match(source, /border components are texture-space fractions between 0 and 1/);
  assert.match(source, /requires exactly one of sprite=<name> or index=<n> after the atlas/);
  assert.match(source, /requires a JSON asset of " \+ dataType/);
  assert.match(source, /requires a FlaxEngine\.VideoPlayer actor/);
  // Every asset inside a brush goes through the type-checked member resolver.
  assert.match(coerce, /CoerceAssetReference\(typeof\(Texture\), asset, label \+ " requires "\) as Texture/);
  assert.match(coerce, /CoerceAssetReference\(typeof\(MaterialBase\), asset, label \+ " requires "\) as MaterialBase/);
  assert.match(source, /CoerceAssetReference\(typeof\(SpriteAtlas\), atlasText, label \+ " requires "\) as SpriteAtlas/);
  // Brush fields are set through constructors and initializers, not reflection.
  assert.doesNotMatch(source, /PropertyInfo\.SetValue/);
  assert.doesNotMatch(source, /FieldInfo\.SetValue/);
  assert.doesNotMatch(source, /field\.SetValue\(/);
});

test('font strings carry the two properties the Editor font editor edits and never produce a null reference', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /FlaxEditor\.CustomEditors\.Dedicated\.FontReferenceEditor/);
  const coerce = method(source, 'private static object CoerceFontValue(string text, string need, string memberName)');
  // Label.DrawSelf dereferences the reference, so "" is an empty reference, not null.
  assert.match(coerce, /if \(text\.Length == 0\) return new FontReference\(\);/);
  assert.doesNotMatch(coerce, /return null;/);
  assert.match(coerce, /if \(!options\.TryGetValue\("size", out sizeText\)\) throw/);
  assert.match(coerce, /the Editor limit for FontReference\.Size/);
  assert.match(coerce, /new FontReference\(CoerceAssetReference\(typeof\(FontAsset\), assetText, label \+ " requires "\) as FontAsset, size\)/);
  // The size bounds come from the engine attribute, with its shipped values as the fallback.
  const limits = method(source, 'private static void FontSizeLimits(out float min, out float max)');
  assert.match(limits, /typeof\(FontReference\)\.GetProperty\("Size"\)/);
  assert.match(limits, /typeof\(LimitAttribute\)/);
});

test('engine assets resolve only from the engine asset registry and never expose an absolute path', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /private const string EngineAssetPrefix = "engine:";/);
  assert.match(source, /Path\.GetFullPath\(Globals\.EngineContentFolder\)/);
  // Registry lookups only: the bridge never loads by a path built from caller input.
  assert.doesNotMatch(source, /LoadAsyncInternal\(/);
  assert.doesNotMatch(source, /Content\.LoadInternal\(/);
  const byPath = method(source, 'private static McpAssetRecord FindEngineAssetRecord(string internalPath)');
  assert.match(byPath, /Content\.GetAllAssets\(\)/);
  assert.match(byPath, /string\.Equals\(record\.Path, wanted, StringComparison\.OrdinalIgnoreCase\)/);
  const byId = method(source, 'private static McpAssetRecord FindEngineAssetRecord(Guid id)');
  assert.match(byId, /Content\.GetAssetInfo\(id, out info\)/);
  // A record exists only for a .flax file below the engine Content folder.
  const internal = method(source, 'private static string EngineInternalAssetPath(string absolutePath, string engineRoot)');
  assert.match(internal, /relative\.StartsWith\("\.\.\/", StringComparison\.Ordinal\)/);
  assert.match(internal, /Path\.IsPathRooted\(relative\)/);
  assert.match(internal, /relative\.EndsWith\("\.flax", StringComparison\.OrdinalIgnoreCase\)/);
  // The engine: form rejects traversal, separators, drive letters, and extensions before any lookup.
  const validate = method(source, 'private static string ValidateEngineInternalPath(string value)');
  assert.match(validate, /value\.IndexOf\('\\\\'\) >= 0/);
  assert.match(validate, /value\.IndexOf\(':'\) >= 0/);
  assert.match(validate, /part == "\.\."/);
  assert.match(validate, /value\.EndsWith\("\.flax", StringComparison\.OrdinalIgnoreCase\)/);
  // Project assets win, engine content is the fallback, anything else is not found.
  const resolve = method(source, 'private static McpAssetRecord ResolveMemberAssetRecord(string text, string need)');
  assert.match(resolve, /foreach \(var record in BuildAssetRegistry\(\)\) if \(record\.Id == id\) return record;/);
  assert.match(resolve, /Asset was not found in the project Content registry or the engine content registry\./);
  assert.match(resolve, /Asset was not found in the engine content registry: /);
  assert.match(resolve, /return ResolveAssetRecord\(new McpAssetGet \{ Path = text \}, BuildAssetRegistry\(\)\);/);
  // The loaded asset is still type-checked and ID-checked exactly as a project asset is.
  const load = method(source, 'private static Asset CoerceAssetReference(Type assetType, string text, string need)');
  assert.match(load, /var record = ResolveMemberAssetRecord\(text, need\);/);
  assert.match(load, /Content\.LoadAsync\(record\.Id, assetType\)/);
  assert.match(load, /if \(!assetType\.IsInstanceOfType\(asset\)\)/);
  assert.match(load, /if \(asset\.ID != record\.Id\)/);
  // Read-back: the reference form comes from the registry, project form first.
  const reference = method(source, 'private static string MemberAssetReferencePath(Guid id)');
  assert.match(reference, /AssetProjectRelativePath\(info\.Path\)/);
  assert.match(reference, /EngineAssetPrefix \+ internalPath/);
  // The asset_* tools keep their project-only registry.
  const registry = method(source, 'private static List<McpAssetRecord> BuildAssetRegistry()');
  assert.match(registry, /var assetPath = AssetProjectRelativePath\(info\.Path\);/);
  assert.doesNotMatch(registry, /EngineAsset|EngineContent/);
  // The StaticModel.Model alias sends an engine reference down the generic path.
  assert.match(source, /var isEngineModel = string\.Equals\(q\.Property, "StaticModel\.Model", StringComparison\.Ordinal\) && IsEngineAssetReference\(q\.Text\);/);
});

test('brush, font, and asset values read back in the form the write path accepts', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const project = method(source, 'private static McpMaterialTypedValue ProjectMemberValue(object raw, Type declaredType)');
  assert.match(project, /Kind = "brush", Text = LimitForLog\(brushText, MaxBrushTextChars\), AssetId = brushAssetId/);
  assert.match(project, /Kind = "font", Text = LimitForLog\(fontText, MaxBrushTextChars\), AssetId = fontAssetId, Number = fontReference\.Size/);
  assert.match(project, /Kind = "asset", AssetId = assetReference\.ID\.ToString\("N"\), Text = MemberAssetReferencePath\(assetReference\.ID\)/);
  assert.match(project, /Kind = "asset", AssetId = json\.ID\.ToString\("N"\), Text = MemberAssetReferencePath\(json\.ID\)/);
  const describe = method(source, 'private static string DescribeBrush(object raw, bool byId, out string assetId)');
  for (const kind of ['solid', 'gradient', 'texture', 'texture9', 'sprite', 'sprite9', 'material', 'ui_brush', 'video']) {
    assert.ok(describe.includes(`"${kind}:"`), `DescribeBrush must emit ${kind}`);
  }
  // A brush type without a string form is reported, not invented.
  assert.match(source, /which has no string form; it can be replaced or cleared but not read back\./);
  // No-op detection compares the string form: Sprite9SlicingBrush.Equals ignores its border fields.
  const equal = method(source, 'private static bool MemberValuesEqual(object before, object after)');
  assert.match(equal, /DescribeBrush\(before, true, out ignored\)/);
  assert.match(equal, /DescribeBrush\(after, true, out ignored\)/);
});

test('brush and font writes stay on the undo stack as private copies', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /class McpMemberUndo : IUndoAction/);
  assert.match(source, /member\.SetValue\(target, Unpack\(value\)\)/);
  assert.match(source, /return sceneObject == null \? FlaxMcpBridgePlugin\.SnapshotMemberValue\(value\) : new SceneObjectRef \{ Id = sceneObject\.ID \};/);
  assert.match(source, /if \(reference == null\) return FlaxMcpBridgePlugin\.RestoreMemberValue\(value\);/);
  // A video brush is kept as the player's ID, like every other scene-object reference.
  assert.match(source, /new VideoBrushSnapshot \{ PlayerId = video\.Player == null \? Guid\.Empty : video\.Player\.ID, Filter = video\.Filter \}/);
  assert.match(source, /FObject\.TryFind<VideoPlayer>\(ref id\)/);
  const copy = method(source, 'private static object CopyMemberValue(object value)');
  assert.match(copy, /new FontReference\(font\.Font, font\.Size\)/);
  for (const type of ['SolidColorBrush', 'LinearGradientBrush', 'TextureBrush', 'Texture9SlicingBrush', 'SpriteBrush', 'Sprite9SlicingBrush', 'MaterialBrush', 'UIBrush']) {
    assert.ok(copy.includes(`new FlaxEngine.GUI.${type}`), `CopyMemberValue must copy ${type}`);
  }
  // Hints for values the engine accepts but would not draw ride on the result.
  assert.match(source, /public long SceneRevision; public string\[\] Warnings; \}/);
  assert.match(source, /var warnings = MemberWriteWarnings\(target, slot, coerced\);/);
  assert.match(source, /BackgroundBrush is drawn tinted by BackgroundColor, whose alpha is 0/);
  assert.match(source, /The material is not a GUI-domain material/);
  assert.match(source, /The font reference has no font asset/);
});
