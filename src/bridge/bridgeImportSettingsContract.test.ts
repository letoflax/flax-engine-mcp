import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

/** The bridge source with LF line endings, whatever the checkout uses on disk. */
async function readBridge(): Promise<string> {
  return (await readFile(bridgePath, 'utf8')).replaceAll('\r\n', '\n');
}

/** Returns the source of one C# method, from its signature to its closing brace at class-member indent. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `bridge method not found: ${signature}`);
  const end = source.indexOf('\n        }\n', start);
  assert.ok(end > start, `bridge method end not found: ${signature}`);
  return source.slice(start, end);
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

test('import settings classify by exact registry type before any editor or source access', async () => {
  const source = await readBridge();
  const kinds = methodBody(source, 'private static string ImportSettingsKindForType(string typeName)');
  assert.match(kinds, /"FlaxEngine\.Texture", StringComparison\.Ordinal\)\) return "texture"/);
  assert.match(kinds, /"FlaxEngine\.Model", StringComparison\.Ordinal\)/);
  assert.match(kinds, /"FlaxEngine\.SkinnedModel", StringComparison\.Ordinal\)\) return "model"/);
  assert.match(kinds, /"FlaxEngine\.AudioClip", StringComparison\.Ordinal\)\) return "audio"/);
  // Every TextureBase (CubeTexture, SpriteAtlas, IESProfile) gets a TextureAssetItem, so the item subclass must not decide the kind.
  assert.doesNotMatch(source, /item is TextureAssetItem\) return "texture"/);
  assert.doesNotMatch(kinds, /CubeTexture|SpriteAtlas|IESProfile/);

  const classify = methodBody(source, 'private static string ClassifyImportSettingsAsset(McpAssetRecord record)');
  assert.match(classify, /McpProtocolException\("VALIDATION_FAILED", "Import settings are only supported for texture, model, and audio assets/);

  const get = methodBody(source, 'private McpAssetImportSettingsResult GetAssetImportSettings(McpAssetImportSettingsGet request)');
  assert.ok(get.indexOf('ClassifyImportSettingsAsset(record)') < get.indexOf('RequireImportSettingsItem(record, kind)'), 'get classifies before the editor item lookup');
  assert.doesNotMatch(get, /IMPORT_FAILED/);

  const set = methodBody(source, 'private McpAssetImportSettingsSetResult SetAssetImportSettings(McpAssetImportSettingsSet request)');
  const classifyAt = set.indexOf('ClassifyImportSettingsAsset(record)');
  assert.ok(classifyAt >= 0);
  for (const later of ['Content.Load(record.Id, AssetLoadTimeoutMs)', 'binary.ImportPath', 'ValidateAssetImportSource(', 'FEditor.CanImport(']) {
    assert.ok(classifyAt < set.indexOf(later), `set classifies before ${later}`);
  }
  // Requested values are validated (inside BuildImportSettings) before the asset is loaded too.
  assert.ok(set.indexOf('BuildImportSettings(record, item, kind, request.Settings') < set.indexOf('Content.Load(record.Id, AssetLoadTimeoutMs)'));
});

test('import-settings writes are refused when the current options cannot be restored', async () => {
  const source = await readBridge();
  const set = methodBody(source, 'private McpAssetImportSettingsSetResult SetAssetImportSettings(McpAssetImportSettingsSet request)');
  const refusal = set.indexOf('if (!before.Restored)');
  assert.ok(refusal >= 0);
  assert.match(set.slice(refusal, refusal + 400), /throw new McpProtocolException\("IMPORT_FAILED", "The asset's current import options could not be restored/);
  // The refusal covers the dry-run preview and the write alike.
  assert.ok(refusal < set.indexOf('if (request.DryRun)'));
  assert.ok(refusal < set.indexOf('QueueAssetReimport('));

  // One restore per request: before, after, and the Reimport settings object share one restored value.
  const build = methodBody(source, 'private static McpAssetImportSettingsResult BuildImportSettings(');
  for (const restore of ['TryRestoreTextureSettings(item, out options)', 'TryRestoreModelSettings(item, out options)', 'TryRestoreAudioSettings(item, out options)']) {
    assert.equal(count(source, restore), 1, `${restore} is called exactly once`);
    assert.equal(count(build, restore), 1);
  }
  assert.doesNotMatch(set, /TryRestore(Texture|Model|Audio)Settings/);
  assert.doesNotMatch(source, /ReadImportSettings\(/);

  // The older model-type reimport path replaces options wholesale as well.
  const model = methodBody(source, 'private static object BuildModelReimportSettings(BinaryAssetItem item, string modelImportType)');
  assert.match(model, /if \(!FEditor\.TryRestoreImportOptions\(ref importSettings\.Settings, item\.Path\)\)\s+throw new McpProtocolException\("IMPORT_FAILED"/);
});

test('import-settings ranges match the Flax 1.12 engine limits and reject NaN', async () => {
  const source = await readBridge();
  assert.match(source, /RequireSettingFloat\(entry, 0\.0, 175\.0, "SmoothingNormalsAngle must be between 0 and 175\."\)/);
  assert.match(source, /RequireSettingFloat\(entry, 0\.0, 45\.0, "SmoothingTangentsAngle must be between 0 and 45\."\)/);
  assert.match(source, /RequireSettingInt\(entry, 0, 5, "BaseLOD must be between 0 and 5\."\)/);
  assert.match(source, /RequireSettingInt\(entry, 1, 6, "LODCount must be between 1 and 6\."\)/);
  assert.match(source, /RequireSettingFloat\(entry, 0\.0001, 8\.0, "Scale must be between 0\.0001 and 8\."\)/);
  assert.match(source, /RequireSettingFloat\(entry, 0\.001, 1000\.0, "Scale must be between 0\.001 and 1000\."\)/);
  assert.match(source, /RequireSettingFloat\(entry, 0\.0, 1\.0, "Quality must be between 0 and 1\."\)/);
  assert.match(source, /RequireSettingInt\(entry, 1, 16384, "MaxSize must be between 1 and 16384\."\)/);
  assert.doesNotMatch(source, /Smoothing(Normals|Tangents)Angle must be between 0 and 180/);
  assert.doesNotMatch(source, /BaseLOD must be between 0 and 16\./);
  assert.doesNotMatch(source, /LODCount must be between 1 and 16\./);
  assert.doesNotMatch(source, /Scale must be greater than 0/);

  // NaN fails a negated conjunction; "value < min || value > max" would let it through.
  const float = methodBody(source, 'private static float RequireSettingFloat(McpImportSettingsEntry entry, double min, double max, string rangeMessage)');
  assert.match(float, /if \(!\(value >= min && value <= max\)\) throw new McpProtocolException\("VALIDATION_FAILED", rangeMessage\)/);
  assert.doesNotMatch(float, /value < min \|\| value > max/);
  assert.doesNotMatch(source, /(angle|quality|scale) < 0\.0\d* \|\| (angle|quality|scale) > /);
  // Every scalar helper requires exactly one populated slot.
  for (const helper of ['RequireSettingBool', 'RequireSettingInt', 'RequireSettingFloat', 'RequireSettingEnum']) {
    assert.match(source, new RegExp(`${helper}\\(McpImportSettingsEntry entry[^)]*\\)\\s+\\{\\s+if \\(ImportSettingScalarCount\\(entry\\.Value\\) != 1`));
  }
});

test('an adopted import-settings operation replays its stored preview instead of a no-change result', async () => {
  const source = await readBridge();
  assert.match(source, /class McpAssetImportSettingsSetResult \{ public McpAssetOperation Operation; public bool\? WouldChange; [^}]*public bool Adopted; \}/);
  const set = methodBody(source, 'private McpAssetImportSettingsSetResult SetAssetImportSettings(McpAssetImportSettingsSet request)');
  assert.match(set, /if \(adopted\) return AdoptedImportSettingsResult\(operation\);/);
  assert.doesNotMatch(source, /WouldChange = false, Before = null, After = null/);
  assert.equal(count(set, 'RememberImportSettingsResult(operation, '), 3, 'dry-run, no-op, and queued results are all remembered');

  const adopted = methodBody(source, 'private McpAssetImportSettingsSetResult AdoptedImportSettingsResult(McpAssetOperation operation)');
  assert.match(adopted, /_assetImportSettingsResults\.TryGetValue\(operation\.OperationId, out first\)/);
  assert.match(adopted, /Adopted = true/);
  assert.match(adopted, /WouldChange = first == null \? null : first\.WouldChange/);

  // Stored previews are dropped with their operation record.
  const begin = methodBody(source, 'private McpAssetOperation BeginAssetImportOperation(');
  assert.match(begin, /if \(!_assetImportOperations\.ContainsKey\(pair\.Key\)\) orphaned\.Add\(pair\.Key\)/);
  assert.match(begin, /_assetImportSettingsResults\.Remove\(key\)/);
});

test('a reimport is marked running only when the editor will queue it, and a throw clears its pending entry', async () => {
  const source = await readBridge();
  const queue = methodBody(source, 'private void QueueAssetReimport(McpAssetOperation operation, BinaryAssetItem item, Action reimport)');
  // Same two checks ContentImportingModule.Reimport makes before it adds a request.
  const precheck = queue.indexOf('!item.GetImportPath(out engineImportPath) && File.Exists(engineImportPath)');
  const running = queue.indexOf('operation.Phase = "running"');
  const invoke = queue.indexOf('try { reimport(); }');
  assert.ok(precheck >= 0 && running > precheck && invoke > running);
  assert.match(queue, /if \(!queueable\)\s+throw new McpProtocolException\("IMPORT_FAILED"/);
  assert.match(queue.slice(invoke), /catch\s+\{[\s\S]*_pendingReimportsByOutputPath\.Remove\(output\);[\s\S]*throw;/);

  // Both reimport paths go through the helper; nothing else marks an operation running.
  assert.equal(count(source, 'operation.Phase = "running"'), 1);
  assert.equal(count(source, '_pendingReimportsByOutputPath[output] = operation.OperationId'), 1);
  assert.doesNotMatch(source, /_pendingReimportsByOutputPath\[Path\.GetFullPath/);
  assert.match(source, /QueueAssetReimport\(operation, item, \(\) => FEditor\.Instance\.ContentImporting\.Reimport\(item, BuildModelReimportSettings\(item, request\.ModelImportType\), true\)\);/);
  assert.match(source, /QueueAssetReimport\(operation, item, \(\) => FEditor\.Instance\.ContentImporting\.Reimport\(item, settingsObject, true\)\);/);
});

test('asset.get reports import-settings availability per asset type', async () => {
  const source = await readBridge();
  assert.match(source, /class McpAssetGetResult \{ public McpAssetMetadata Asset; public bool ImportSettingsAvailable; public string\[\] Warnings; \}/);
  assert.doesNotMatch(source, /ImportSettingsAvailable = false/);
  const get = methodBody(source, 'private McpAssetGetResult AssetGet(McpAssetGet request)');
  assert.match(get, /ImportSettingsAvailable = ImportSettingsKindForType\(record\.Info\.TypeName\) != null/);
  const warnings = methodBody(source, 'private static string[] AssetMetadataWarnings()');
  assert.doesNotMatch(warnings, /importer settings are intentionally omitted/);
  assert.match(warnings, /read them with asset\.get_import_settings/);
});
