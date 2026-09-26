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
            // Readiness gate (AcquireGraphSurface/EnsureGraphSurfaceLoaded):
            // the window edits a cloned asset that loads async; the bridge
            // retries while it is not loaded yet and fails fast when loading
            // failed. LoadSurface() itself runs in a later Update() frame.
            Asset surfaceAsset = visject.VisjectAsset;
            bool assetLoaded = surfaceAsset.IsLoaded;
            bool assetLoadFailed = surfaceAsset.LastLoadFailed;
            // Enabled gate: all in-scope windows construct their surface
            // disabled and enable it only in OnSurfaceEditingStart(), after
            // LoadSurface() ran in an Update() frame.
            bool surfaceEnabled = surface.Enabled;

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
            GC.KeepAlive(assetLoaded);
            GC.KeepAlive(assetLoadFailed);
            GC.KeepAlive(surfaceEnabled);
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

            // Bridge v17 Phase 3 bounded AnimGraph macros (compile-proof only):
            // archetype IDs come from a Cecil dump of the local 1.12 binary
            // (machine=(9,18), state=(9,20)); every ID is re-gated at runtime
            // via GetArchetype + CanUseNodeType, and spawn values are cloned
            // from the resolved archetype defaults (never hardcoded).
            GroupArchetype stateGroup;
            NodeArchetype stateArch;
            bool hasStateArch = NodeFactory.GetArchetype(NodeFactory.DefaultGroups, (ushort)9, (ushort)20, out stateGroup, out stateArch);
            object[] stateDefaults = stateArch == null || stateArch.DefaultValues == null ? null : (object[])stateArch.DefaultValues.Clone();
            bool canUseState = surface.CanUseNodeType((ushort)9, (ushort)20);
            SurfaceNode machineByType = surface.FindNode((ushort)9, (ushort)18);
            SurfaceNode machineById = node == null ? null : surface.FindNode(node.ID);
            VisjectSurfaceContext machineCtx = node == null ? null : surface.FindContext(new Span<uint>(new uint[] { node.ID }));
            uint ownerCheck = machineCtx == null ? 0u : machineCtx.OwnerNodeID;
            int nestedCount = machineCtx == null || machineCtx.Nodes == null ? 0 : machineCtx.Nodes.Count;
            SurfaceNode nestedState = machineCtx == null ? null : machineCtx.FindNode((ushort)9, (ushort)20);
            VisjectSurfaceContext rootAgain = surface.OpenContext(new Span<uint>(new uint[0]));
            IConnectionInstigator instigator = node as IConnectionInstigator;
            bool canConnect = instigator != null && nestedState != null && instigator.CanConnectWith(nestedState as IConnectionInstigator);
            if (instigator != null && nestedState != null && canConnect) instigator.Connect(nestedState as IConnectionInstigator);
            try { root.MarkAsModified(true); } catch { }
            try { if (machineCtx != null) machineCtx.MarkAsModified(true); } catch { }
            GC.KeepAlive(hasStateArch);
            GC.KeepAlive(stateDefaults);
            GC.KeepAlive(canUseState);
            GC.KeepAlive(machineByType);
            GC.KeepAlive(machineById);
            GC.KeepAlive(machineCtx);
            GC.KeepAlive(ownerCheck);
            GC.KeepAlive(nestedCount);
            GC.KeepAlive(nestedState);
            GC.KeepAlive(rootAgain);
            GC.KeepAlive(canConnect);
        }

        internal static void Phase5(
            VisjectSurface surface,
            VisjectSurfaceContext root,
            SurfaceNode node,
            Box fromBox,
            Box toBox)
        {
            // Bridge v18 Phase 5ab (compile-proof only): Delete(batch) is the
            // undo-aware removal path (withUndo:true pushes AddRemoveNodeAction
            // + EditNodeConnections); the engine skips NoRemove-flagged nodes.
            // BreakConnection/RemoveConnections push no undo action and do not
            // mark edited (Cecil-verified on the local 1.12 binary).
            SurfaceNode byId = root.FindNode(node.ID);
            Box target = null;
            for (int bi = 0; bi < 64; bi++)
            {
                Box found;
                if (!node.TryGetBox(bi, out found) || found == null) continue;
                if (found.ID == toBox.ID) { target = found; break; }
            }
            bool noRemove = node.Archetype != null && (node.Archetype.Flags & FlaxEditor.Surface.NodeFlags.NoRemove) != 0;
            uint packed = node.Type;
            ushort group = (ushort)(packed >> 16);
            ushort type = (ushort)(packed & 0xFFFF);
            bool knownWire = (fromBox.Connections != null && fromBox.Connections.Contains(toBox))
                || (toBox.Connections != null && toBox.Connections.Contains(fromBox));
            bool directionOk = fromBox.IsOutput != toBox.IsOutput;
            if (directionOk && knownWire && !noRemove)
            {
                surface.Delete(new SurfaceControl[] { node }, true);
                fromBox.BreakConnection(toBox);
                toBox.RemoveConnections(0);
            }
            root.MarkAsModified(true);
            surface.MarkAsEdited(true);
            GC.KeepAlive(byId);
            GC.KeepAlive(target);
            GC.KeepAlive(group);
            GC.KeepAlive(type);
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
