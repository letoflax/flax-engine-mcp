import { z } from 'zod';
import type { ProjectMeta } from '../projectContext.js';
import { toolError, toolResult, type ToolResponse } from '../errors.js';
import { allowedToolNames, policyForContext } from '../permissions.js';

export const SearchToolsSchema = z.object({
  query: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

export interface SearchableTool {
  name: string;
  description: string;
  annotations: { readOnlyHint?: boolean };
}

function rankFor(name: string, description: string, needle: string): number | null {
  const lowerName = name.toLowerCase();
  const lowerDesc = description.toLowerCase();
  if (lowerName === needle) return 0;
  if (lowerName.startsWith(needle)) return 1;
  if (lowerName.includes(needle)) return 2;
  if (lowerDesc.includes(needle)) return 3;
  return null;
}

export function filterAndRankTools<T extends SearchableTool>(tools: readonly T[], query: string): T[] {
  const needle = query.toLowerCase();
  const scored: Array<{ tool: T; rank: number }> = [];
  for (const tool of tools) {
    const rank = rankFor(tool.name, tool.description, needle);
    if (rank !== null) scored.push({ tool, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0));
  return scored.map(entry => entry.tool);
}

export async function handleSearchTools(args: unknown, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const parsed = SearchToolsSchema.parse(args);
    // Dynamic import keeps this module free of a static cycle back into the
    // registry while still searching the live registry at call time.
    // Fully offline: no bridge access.
    const { buildToolRegistry } = await import('./index.js');
    const registry = buildToolRegistry(ctx);
    const policy = policyForContext(ctx);
    const allowed = new Set(allowedToolNames(registry.map(tool => tool.name), policy));
    const visible = registry.filter(tool => allowed.has(tool.name));
    const total_tools = visible.length;
    const ranked = filterAndRankTools(visible, parsed.query);
    const sliced = ranked.slice(0, parsed.limit);
    const tools = sliced.map(tool => ({
      name: tool.name,
      description: tool.description,
      read_only: tool.annotations.readOnlyHint ?? false,
    }));
    const data = {
      query: parsed.query,
      count: tools.length,
      total_tools,
      tools,
    };
    if (tools.length === 0) {
      return toolResult(`No tools match "${parsed.query}". (${total_tools} tools visible under the active policy.)`, { data });
    }
    const lines = tools.map(tool => `- ${tool.name}: ${tool.description} [${tool.read_only ? 'read-only' : 'write'}]`);
    return toolResult(`Found ${tools.length} tool(s) for "${parsed.query}":\n${lines.join('\n')}`, { data });
  } catch (error) {
    return toolError(error);
  }
}
