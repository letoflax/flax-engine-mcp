// Compile-only probe for the public Flax 1.12 Visject graph API surface used by bridge v16.
// Window-backed scope only: AnimationGraph / Material / ParticleEmitter.
// It deliberately does not execute engine calls.
using System;
using System.Collections.Generic;
using FlaxEditor;
using FlaxEditor.Content;
using FlaxEditor.Surface;
using FlaxEditor.Surface.Elements;
using FlaxEditor.Windows.Assets;
using FlaxEngine;

namespace FlaxMcpCompileSmoke
{
    internal static class VisjectGraphApiCompileProbe
    {
        internal static void Inspect(
            AnimationGraphWindow animWindow,
            MaterialWindow matWindow,
            ParticleEmitterWindow fxWindow,
            VisjectSurface surface,
            SurfaceNode node,
            Box box,
            SurfaceParameter parameter)
        {
            IVisjectSurfaceWindow visject = animWindow;
            VisjectSurface viaInterface = visject.VisjectSurface;
            Asset visjectAsset = visject.VisjectAsset;
            // IVisjectSurfaceOwner.Undo is public API (FlaxEngine.CSharp.xml):
            // the bridge casts windows to this interface instead of reflecting
            // over GetProperty("Undo").
            IVisjectSurfaceOwner owner = animWindow;
            FlaxEditor.Undo ownerUndo = owner.Undo;

            VisjectSurface animSurface = animWindow.Surface;
            FlaxEditor.Undo animUndo = animWindow.Undo;
            VisjectSurface animVisject = animWindow.VisjectSurface;
            byte[] animData = animWindow.SurfaceData;
            animWindow.SurfaceData = animData;
            bool refreshed = animWindow.RefreshTempAsset();
            AssetEditorWindow saver = animWindow;
            saver.Save();

            GC.KeepAlive(matWindow.Surface);
            GC.KeepAlive(matWindow.Undo);
            GC.KeepAlive(fxWindow.Surface);
            GC.KeepAlive(fxWindow.Undo);
            GC.KeepAlive(viaInterface);
            GC.KeepAlive(visjectAsset);
            GC.KeepAlive(ownerUndo);
            GC.KeepAlive(animSurface);
            GC.KeepAlive(animUndo);
            GC.KeepAlive(animVisject);
            GC.KeepAlive(refreshed);

            List<SurfaceNode> nodes = surface.Nodes;
            List<SurfaceParameter> parameters = surface.Parameters;
            surface.MarkAsEdited(true);
            bool saveFailed = surface.Save();
            bool loadFailed = surface.Load();
            SurfaceParameter byId = surface.GetParameter(Guid.Empty);
            SurfaceParameter byName = surface.GetParameter("Speed");
            surface.OnParamEdited(parameter);
            surface.OnParamCreated(parameter);
            VisjectSurfaceContext context = surface.Context;
            VisjectSurfaceContext root = surface.RootContext;
            GC.KeepAlive(nodes);
            GC.KeepAlive(parameters);
            GC.KeepAlive(saveFailed);
            GC.KeepAlive(loadFailed);
            GC.KeepAlive(byId);
            GC.KeepAlive(byName);
            GC.KeepAlive(context);
            GC.KeepAlive(root);

            Guid paramId = parameter.ID;
            object paramValue = parameter.Value;
            parameter.Value = paramValue;
            string paramName = parameter.Name;
            bool paramPublic = parameter.IsPublic;
            var paramType = parameter.Type;
            GC.KeepAlive(paramId);
            GC.KeepAlive(paramName);
            GC.KeepAlive(paramPublic);
            GC.KeepAlive(paramType);

            uint nodeId = node.ID;
            object[] values = node.Values;
            GroupArchetype groupArchetype = node.GroupArchetype;
            NodeArchetype nodeArchetype = node.Archetype;
            string title = node.Title;
            Float2 location = node.Location;
            Box firstBox = node.GetBox(0);
            Box foundBox;
            bool hasBox = node.TryGetBox(0, out foundBox);
            node.SetValue(0, null, false);
            ushort groupId = groupArchetype.GroupID;
            ushort typeId = nodeArchetype.TypeID;
            GC.KeepAlive(nodeId);
            GC.KeepAlive(values);
            GC.KeepAlive(title);
            GC.KeepAlive(location);
            GC.KeepAlive(firstBox);
            GC.KeepAlive(foundBox);
            GC.KeepAlive(hasBox);
            GC.KeepAlive(groupId);
            GC.KeepAlive(typeId);

            int boxId = box.ID;
            bool isOutput = box.IsOutput;
            List<Box> connections = box.Connections;
            SurfaceNode parent = box.ParentNode;
            bool connected = box.AreConnected(box);
            bool canUse = box.CanUseType(box.CurrentType);
            box.CreateConnection(box);
            GC.KeepAlive(boxId);
            GC.KeepAlive(isOutput);
            GC.KeepAlive(connections);
            GC.KeepAlive(parent);
            GC.KeepAlive(connected);
            GC.KeepAlive(canUse);

            GroupArchetype group;
            NodeArchetype archetype;
            bool hasArchetype = NodeFactory.GetArchetype(NodeFactory.DefaultGroups, (ushort)0, (ushort)0, out group, out archetype);
            SurfaceNode spawned = context.SpawnNode((ushort)0, (ushort)0, new Float2(0, 0), null, null);
            SurfaceNode spawned2 = context.SpawnNode(group, archetype, new Float2(0, 0), null, null);
            GC.KeepAlive(hasArchetype);
            GC.KeepAlive(spawned);
            GC.KeepAlive(spawned2);
        }

        internal static void Modules(ContentItem item, Asset asset)
        {
            FlaxEditor.Windows.EditorWindow byAsset = FlaxEditor.Editor.Instance.ContentEditing.Open(asset, true);
            FlaxEditor.Windows.EditorWindow byItem = FlaxEditor.Editor.Instance.ContentEditing.Open(item, true);
            FlaxEditor.Windows.EditorWindow found = FlaxEditor.Editor.Instance.Windows.FindEditor(item);
            FlaxEditor.Editor.Instance.Windows.CloseAllEditors(item);
            bool headless = FlaxEditor.Editor.Instance.IsHeadlessMode;
            GC.KeepAlive(byAsset);
            GC.KeepAlive(byItem);
            GC.KeepAlive(found);
            GC.KeepAlive(headless);
        }

        internal static void Assets(AnimationGraph graph, Material material)
        {
            byte[] graphBytes = graph.LoadSurface();
            bool graphFailed = graph.SaveSurface(graphBytes);
            byte[] matBytes = material.LoadSurface(false);
            MaterialInfo info = material.Info;
            bool matFailed = material.SaveSurface(matBytes, info);
            bool saved = ((Asset)material).Save(null);
            GC.KeepAlive(graphFailed);
            GC.KeepAlive(matFailed);
            GC.KeepAlive(saved);
        }

        internal static void UndoAndTypes(FlaxEditor.Undo undo, SurfaceParameter parameter)
        {
            undo.AddAction(new ProbeUndo());
            undo.PerformUndo();
            bool canUndo = undo.CanUndo;
            string firstUndo = undo.FirstUndoName;
            var scriptType = new FlaxEditor.Scripting.ScriptType(typeof(bool));
            var created = new SurfaceParameter
            {
                ID = Guid.NewGuid(),
                Name = "Probe",
                Type = scriptType,
                IsPublic = true,
                Value = false,
            };
            GC.KeepAlive(canUndo);
            GC.KeepAlive(firstUndo);
            GC.KeepAlive(created);
            GC.KeepAlive(parameter);
        }

        private sealed class ProbeUndo : IUndoAction
        {
            public string ActionString { get { return "Probe"; } }
            public void Do() { }
            public void Undo() { }
            public void Dispose() { }
        }
    }
}
