import { z } from 'zod';
import { ProjectMeta } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const GenerateScriptSchema = z.object({
  template: z.enum([
    'basic_script',
    'network_script',
    'weapon_script',
    'player_input',
    'animation_driver',
    'scene_manager',
  ]).describe('Template to use'),
  name: z.string().describe('Class name for the script (e.g. "EnemyScript")'),
  namespace: z.string().optional().default('Game').describe('C# namespace (default: Game)'),
  save: z.boolean().optional().default(false).describe('Save to Source/Game/<name>.cs automatically'),
});

const TEMPLATES: Record<string, (name: string, ns: string) => string> = {
  basic_script: (name, ns) => `using FlaxEngine;

namespace ${ns};

public class ${name} : Script
{
    public override void OnStart()
    {
    }

    public override void OnUpdate()
    {
    }

    public override void OnFixedUpdate()
    {
    }
}
`,

  network_script: (name, ns) => `using FlaxEngine;
using FlaxEngine.Networking;

namespace ${ns};

public class ${name} : Script, INetworkObject
{
    [NetworkReplicated]
    public float Health { get; private set; } = 100f;

    public NetworkObjectRole Role { get; set; }

    public void Awake(uint ownerId)
    {
    }

    [NetworkRpc(NetworkRpcMode.Server)]
    public void ServerRpc_Action()
    {
    }

    [NetworkRpc(NetworkRpcMode.Client)]
    public void ClientRpc_Action()
    {
    }

    public override void OnUpdate()
    {
        if (Role != NetworkObjectRole.OwnedAuthoritative)
            return;

        // Owner-only logic here
    }
}
`,

  weapon_script: (name, ns) => `using FlaxEngine;

namespace ${ns};

public class ${name} : Script
{
    public Actor FirePoint;
    public float Damage = 25f;
    public float Range = 10000f;
    public float ImpulseForce = 60000f;

    public void Fire()
    {
        if (FirePoint == null) return;

        if (Physics.RayCast(FirePoint.Position, FirePoint.Transform.Forward, out RayCastHit hit, Range))
        {
            Debug.Log($"Hit: {hit.Collider?.Name} at {hit.Distance:F1}u");

            var rb = hit.Collider?.AttachedRigidBody;
            if (rb != null && !rb.IsKinematic)
                rb.AddForce(FirePoint.Transform.Forward * ImpulseForce, ForceMode.Impulse);
        }

        DebugDraw.DrawRay(FirePoint.Position, FirePoint.Transform.Forward * Range, Color.Red, 0.5f);
    }
}
`,

  player_input: (name, ns) => `using FlaxEngine;

namespace ${ns};

public class ${name} : Script
{
    public float MoveSpeed = 10f;
    public float LookSpeed = 0.5f;

    private float _pitch;
    private float _yaw;
    private Float3 _moveInput;

    public override void OnUpdate()
    {
        // Look
        var mouse = new Float2(Input.GetAxis("Mouse X"), Input.GetAxis("Mouse Y"));
        _yaw   += mouse.X * LookSpeed;
        _pitch  = Mathf.Clamp(_pitch + mouse.Y * LookSpeed, -88f, 88f);

        // Move
        _moveInput = Float3.Zero;
        if (Input.GetKey(KeyboardKeys.W)) _moveInput.Z += 1f;
        if (Input.GetKey(KeyboardKeys.S)) _moveInput.Z -= 1f;
        if (Input.GetKey(KeyboardKeys.A)) _moveInput.X -= 1f;
        if (Input.GetKey(KeyboardKeys.D)) _moveInput.X += 1f;
        _moveInput.Normalize();

        // Actions
        if (Input.GetAction("Fire"))
        {
            OnFire();
        }
    }

    public override void OnLateUpdate()
    {
        Actor.Orientation = Quaternion.Euler(0f, _yaw, 0f);
    }

    private void OnFire()
    {
        // Override in subclass or assign a callback
    }
}
`,

  animation_driver: (name, ns) => `using FlaxEngine;

namespace ${ns};

public class ${name} : Script
{
    public AnimatedModel Model;

    // Anim Graph parameter names
    private const string ParamAimPitch = "AimPitch";
    private const string ParamAimYaw   = "AimYaw";
    private const string ParamSpeed    = "Speed";
    private const string ParamIsGrounded = "IsGrounded";

    private float _pitch;
    private float _yaw;

    public void SetAim(float pitch, float yaw)
    {
        _pitch = pitch;
        _yaw   = yaw;
    }

    public override void OnUpdate()
    {
        if (Model == null) return;

        Model.SetParameterValue(ParamAimPitch,   _pitch);
        Model.SetParameterValue(ParamAimYaw,     _yaw);
        // Model.SetParameterValue(ParamSpeed,   currentSpeed);
        // Model.SetParameterValue(ParamIsGrounded, isGrounded);
    }
}
`,

  scene_manager: (name, ns) => `using FlaxEngine;

namespace ${ns};

public class ${name} : Script
{
    public bool LockCursorOnStart = true;
    public KeyboardKeys PauseKey  = KeyboardKeys.Escape;

    private bool _paused;

    public override void OnStart()
    {
        if (LockCursorOnStart)
        {
            Screen.CursorVisible = false;
        }
    }

    public override void OnUpdate()
    {
        if (LockCursorOnStart && !_paused)
            Screen.CursorLock = CursorLockMode.Locked;

        if (Input.GetKeyUp(PauseKey))
            SetPaused(!_paused);
    }

    public void SetPaused(bool paused)
    {
        _paused = paused;
        Screen.CursorLock    = paused ? CursorLockMode.None : CursorLockMode.Locked;
        Screen.CursorVisible = paused;
        Time.TimeScale       = paused ? 0f : 1f;
    }
}
`,
};

export async function handleGenerateScript(
  args: z.infer<typeof GenerateScriptSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const fn = TEMPLATES[args.template];
    if (!fn) return toolError(new Error(`Unknown template: ${args.template}`));

    const ns = args.namespace ?? 'Game';
    const content = fn(args.name, ns);

    if (args.save) {
      const { handleWriteScript } = await import('./scripts.js');
      const result = await handleWriteScript({ name: `${args.name}.cs`, content, overwrite: false }, ctx);
      const first = result.content[0];
      const saved = first && 'text' in first ? first.text : '';
      return toolResult(`Generated from template "${args.template}":\n\n${content}\n---\n${saved}`);
    }

    return toolResult(`Generated from template "${args.template}" (not saved — set save:true to write to disk):\n\n${content}`);
  } catch (e) {
    return toolError(e);
  }
}
