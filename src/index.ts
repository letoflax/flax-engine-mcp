#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createProjectContext } from './projectContext.js';
import { buildToolRegistry } from './tools/index.js';
import { toolError } from './errors.js';

function parseProjectPath(): string {
  const idx = process.argv.indexOf('--project-path');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  const first = process.argv[2];
  if (first && !first.startsWith('--')) return first;
  throw new Error(
    'Usage: flax-mcp --project-path /path/to/flax/project\n' +
    'Example: flax-mcp --project-path /home/user/Projects/flax/test-flax'
  );
}

async function main(): Promise<void> {
  const projectPath = parseProjectPath();
  const ctx = await createProjectContext(projectPath);

  process.stderr.write(`Flax MCP Server — project: ${ctx.projectName} (${ctx.projectPath})\n`);

  const server = new Server(
    { name: 'flax-engine-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const tools = buildToolRegistry(ctx);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return toolError(new Error(`Unknown tool: ${name}`));
    }
    try {
      return await tool.handler(args ?? {}, ctx);
    } catch (error) {
      return toolError(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Flax MCP Server ready on stdio.\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
