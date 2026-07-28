#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createProjectContext } from './projectContext.js';
import { buildToolRegistry, ToolDefinition } from './tools/index.js';
import { finalizeToolResponse, toolError, ToolDomainError, ToolResponse } from './errors.js';
import { ProjectMeta } from './projectContext.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export function parseProjectPath(argv = process.argv): string {
  const idx = argv.indexOf('--project-path');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1];
  }
  const first = argv[2];
  if (first && !first.startsWith('--')) return first;
  throw new Error(
    'Usage: flax-mcp --project-path /path/to/flax/project\n' +
    'Example: flax-mcp --project-path /home/user/Projects/flax/test-flax'
  );
}

/**
 * The only tool invocation path. It makes Zod schemas authoritative, including
 * defaults, and keeps legacy handlers free to focus on their domain work.
 */
export async function dispatchToolCall(
  tools: ToolDefinition[],
  name: string,
  rawArgs: unknown,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  const operationId = randomUUID();
  const startedAt = performance.now();
  const finalize = (response: ToolResponse) =>
    finalizeToolResponse(response, operationId, Math.round(performance.now() - startedAt));

  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) {
    return finalize(toolError(new ToolDomainError('UNKNOWN_TOOL', `Unknown tool: ${name}`)));
  }

  const parsed = tool.zodInputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return finalize(toolError(parsed.error));
  }

  try {
    return finalize(await tool.handler(parsed.data, ctx));
  } catch (error) {
    return finalize(toolError(error));
  }
}

async function main(): Promise<void> {
  const projectPath = parseProjectPath();
  const ctx = await createProjectContext(projectPath);

  process.stderr.write(`Flax MCP Server — project: ${ctx.projectName} (${ctx.projectPath})\n`);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  const tools = buildToolRegistry(ctx);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchToolCall(tools, name, args, ctx);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Flax MCP Server ready on stdio.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
