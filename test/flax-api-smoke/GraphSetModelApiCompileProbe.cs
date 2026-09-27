// Compile-only probe for the public Flax 1.12 AnimationGraph base-model API used by bridge v21 graph.set_model.
// It deliberately does not execute engine calls.
using System;
using FlaxEditor.Windows.Assets;
using FlaxEngine;

namespace FlaxMcpCompileSmoke
{
    internal static class GraphSetModelApiCompileProbe
    {
        internal static void SetModel(AnimationGraphWindow window, SkinnedModel model, AnimationGraph graph)
        {
            // Write path used by graph.set_model: window-level setter.
            // Cecil-verified on FlaxEngine.CSharp.dll 1.12: PropertiesProxy.set_BaseModel
            // stores _baseModel + assigns PreviewActor.SkinnedModel and pushes NO
            // undo action (no Undo.AddAction in IL) — non-undoable like disconnect/move.
            window.SetBaseModel(model);

            // Read path for dry-run preview / idempotent no-op guard.
            SkinnedModel current = graph.BaseModel;
            Guid currentId = current == null ? Guid.Empty : current.ID;
            AnimatedModel preview = window.PreviewActor;

            GC.KeepAlive(current);
            GC.KeepAlive(currentId);
            GC.KeepAlive(preview);
            GC.KeepAlive(graph);
        }

        internal static void LoadModel(Guid id, string path)
        {
            // Registry-validated load used before SetBaseModel.
            SkinnedModel byId = Content.LoadAsync<SkinnedModel>(id);
            SkinnedModel byPath = Content.LoadAsync<SkinnedModel>(path);
            GC.KeepAlive(byId);
            GC.KeepAlive(byPath);
        }
    }
}
