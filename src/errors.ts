import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolResponse = CallToolResult;

export function formatToolError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('ENOENT')) return `File not found: ${msg}`;
    if (msg.includes('EACCES') || msg.includes('EPERM')) return `Permission denied: ${msg}`;
    if (msg.includes('ENOTDIR')) return `Expected directory: ${msg}`;
    return msg;
  }
  return String(error);
}

export function toolResult(text: string): ToolResponse {
  return { content: [{ type: 'text' as const, text }] };
}

export function toolError(error: unknown): ToolResponse {
  return { content: [{ type: 'text' as const, text: formatToolError(error) }], isError: true };
}
