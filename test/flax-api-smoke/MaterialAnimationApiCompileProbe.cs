// Compile-only probe for the public Flax 1.12 material and animation APIs used by bridge v13.
using FlaxEngine;

namespace FlaxMcpCompileSmoke
{
    internal static class MaterialAnimationApiCompileProbe
    {
        internal static void Inspect(MaterialBase material, MaterialParameter materialParameter, AnimatedModel animatedModel, AnimationGraph graph)
        {
            MaterialParameter[] materialParameters = material.Parameters;
            var materialParameterId = materialParameter.ParameterID;
            var materialParameterType = materialParameter.ParameterType;
            var materialParameterName = materialParameter.Name;
            var materialParameterIsPublic = materialParameter.IsPublic;
            var materialParameterIsOverride = materialParameter.IsOverride;
            object materialParameterValue = materialParameter.Value;

            AnimGraphParameter[] graphParameters = animatedModel.Parameters;
            var graphParameter = animatedModel.GetParameter("Speed");
            object graphParameterValue = animatedModel.GetParameterValue("Speed");
            var graphParameterId = graphParameter.Identifier;
            var graphParameterType = graphParameter.Type;
            var graphParameterName = graphParameter.Name;
            var graphParameterIsPublic = graphParameter.IsPublic;
            object graphParameterDefaultValue = graphParameter.Value;
            var animatedModelGraph = animatedModel.AnimationGraph;
            var animatedModelSkinnedModel = animatedModel.SkinnedModel;
            var graphBaseModel = graph.BaseModel;

            var animationLength = default(Animation).Length;
            var animationDuration = default(Animation).Duration;
            var animationFramesPerSecond = default(Animation).FramesPerSecond;
            var animationInfo = default(Animation).Info;
            var animationInfoLength = animationInfo.Length;
            var animationInfoFramesCount = animationInfo.FramesCount;
            var animationInfoChannelsCount = animationInfo.ChannelsCount;
            var animationInfoKeyframesCount = animationInfo.KeyframesCount;
            var animationInfoMemoryUsage = animationInfo.MemoryUsage;
        }
    }
}
