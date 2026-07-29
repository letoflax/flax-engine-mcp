# Editor integration and compatibility testing

`npm test` includes deterministic integration-shaped tests in
`src/integration/editorIntegration.test.ts`. They generate a small temporary
project (two scenes, prefab, material/texture/model placeholders, ordinary and
network scripts, and an intentional compile error) and drive a simulated
file-RPC Editor peer. They validate DTO shape and failure handling, but do not
start Flax or claim GUI coverage.

The current compatibility metadata is in `test/compatibility-matrix.json`.
It records Windows + Flax 1.12 as the current/recommended baseline, with
headless coverage limited to status, compile, diagnostics, and logs. Flax 1.12
play, viewport capture, and runtime inspection require a headed Editor and a
game window; run those manually on a dedicated project copy. Linux and macOS
are intentionally marked unverified until their workflow has passed.

For a real manual run, install the bundled bridge into a disposable fixture
project, open it using Flax 1.12, then perform the roadmap sequence: connect,
read scene, create/update/attach, undo/redo/save, patch the intentional error,
compile fail/fix/succeed, and (headed only) play/log/stop. Record the result in
the matrix rather than treating the simulated peer as Editor verification.

The integration suite has explicit skips where the host has no configured
Flax Editor, prohibits symlink/junction creation, or the bridge exposes no
cancellable operation API. Scoped temporary directories are removed in every
test, including on a failed assertion.

For the bridge v12 prefab surface, run the compile-only API smoke probe against
the installed Flax 1.12 managed artifact before claiming compatibility:

```powershell
dotnet build test/flax-api-smoke/PrefabApiCompileProbe.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
dotnet build test/flax-api-smoke/BridgeCompileSmoke.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
```

The first probe validates the direct public signatures; the second compiles the
whole bridge source with `FLAX_EDITOR` against the same artifact. Neither starts
Flax or validates Editor Undo behavior; that is why v12 keeps
override/revert/apply/break-link workflows explicitly unsupported.
