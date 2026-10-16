// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceReader } from '../workspace/WorkspaceReader.js';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import { registerSearchTool } from './search.js';
import { registerNotesTools } from './notes.js';
import { registerAssetsTools } from './assets.js';
import { registerActionTools } from './actions.js';

export { registerSearchTool, registerNotesTools, registerAssetsTools, registerActionTools };

/**
 * Registers all official Noust MCP tools onto the given server instance.
 */
export function registerAllTools(server: McpServer, reader: WorkspaceReader, bridge?: BridgeServer): void {
    registerSearchTool(server, reader, bridge);
    registerNotesTools(server, reader, bridge);
    registerAssetsTools(server, reader);
    registerActionTools(server, reader, bridge);
}
