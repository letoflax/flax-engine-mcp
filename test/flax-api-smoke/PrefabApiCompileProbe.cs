// Compile-only probe for the public Flax 1.12 prefab API surface used by bridge v12.
// It deliberately does not execute engine calls.
using System;
using FlaxEngine;

internal static class PrefabApiCompileProbe
{
    internal static bool Create(Actor actor, string outputPath)
        => PrefabManager.CreatePrefab(actor, outputPath, false);

    internal static Actor Instantiate(Prefab prefab, Actor parent, Transform transform)
        => PrefabManager.SpawnPrefab(prefab, parent, transform);

    internal static bool ApplyAll(Actor actor)
        => PrefabManager.ApplyAll(actor);

    internal static bool IsLinkedPrefabRoot(Actor actor)
        => actor.HasPrefabLink && actor.IsPrefabRoot;

    internal static Guid PrefabId(Actor actor)
        => actor.PrefabID;

    internal static Actor PrefabRoot(Actor actor)
        => actor.GetPrefabRoot();

    internal static void BreakLink(Actor actor)
        => actor.BreakPrefabLink();

    internal static Transform MakeTransform(Float3 position, Float3 eulerAngles, Float3 scale)
        => new Transform(new Vector3(position.X, position.Y, position.Z), Quaternion.Euler(eulerAngles), scale);
}
