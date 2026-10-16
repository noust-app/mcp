// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkspaceReader } from './workspace/WorkspaceReader.js';
import { BridgeServer } from './bridge/BridgeServer.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import type { McpServerConfig } from './cli/types.js';

/**
 * System instructions provided to AI models connected to this MCP server.
 */
export const NOUST_SERVER_INSTRUCTIONS = `Noust Workspaces MCP Server:
Real-time connection to the active Noust workspace and visual canvas.

### INSTANT TOOL ROUTING (EXECUTE IN TURN 1):
- Append text to note     -> update_note(noteId, append="...") [SINGLE STEP: Never call get_note first]
- Overwrite note          -> update_note(noteId, content="...")
- Update note title       -> update_note(noteId, title="...")
- Create new note         -> create_note(title="...", content="...")
- Delete note             -> delete_note(noteId)
- Create objective        -> create_objective(title="...", description="...", deadline="...")
- Edit/Complete objective -> update_objective(objectiveId, done=true, ...)
- Delete objective        -> delete_objective(objectiveId)
- Create Nexus page/doc   -> create_document(title="...", content="...")
- Update/Append page/doc  -> update_document(docId, append="...")
- Delete Nexus page/doc   -> delete_document(docId)
- Manage flags             -> create_flag(label="...", color="#..."), update_flag(flagId, label="...", color="#..."), list_flags(), delete_flag(flagId)
- Inspect/Search items     -> get_note(noteId), get_objective(objectiveId), get_document(docId), list_flags(), or search_workspace(query)

### EXECUTION MANDATES:
1. IMMEDIATE ACTION: Call the target mutation tool immediately in your very first turn. Never call 'get_workspace_status' or explore workspace files beforehand; the bridge validates connection status automatically.
2. DISTINCT FLAG COLORS: When asked to create a flag with a distinct color (e.g. 'a shade of orange different from existing flags'), call 'list_flags()' to inspect currently used colors in the domain and choose a distinct hex code.
3. STRICT ISOLATION: NEVER edit, overwrite, or touch local ".noust" files using filesystem tools (write_to_file, replace_file_content). Always and exclusively use Noust MCP tools.
4. BRIDGE OFFLINE / DISCONNECTED: If a mutation tool returns that the bridge is disconnected or rejected, NEVER edit local .noust files directly. Explain the diagnostic to the user (ensure Noust is open with File System Sync linked and MCP Bridge enabled in Settings > Behavior > Workspace).
5. MULTI-WORKSPACE ROUTING: If multiple workspaces are open across browser tabs and the current working directory does not contain a local .noust file, you must specify the 'workspace' parameter (workspace name or ID). If you are unsure which workspace the user meant and multiple are open without a local .noust file, call 'get_workspace_status()' or ask the user which workspace they want to modify.`;

/**
 * Creates and configures the McpServer instance with registered tools.
 */
export function createMcpServer(
    config: McpServerConfig,
    reader?: WorkspaceReader,
    bridge?: BridgeServer
): McpServer {
    const server = new McpServer(
        {
            name: config.serverName,
            version: config.serverVersion
        },
        {
            instructions: NOUST_SERVER_INSTRUCTIONS
        }
    );

    const activeReader = reader ?? new WorkspaceReader({ workspaceDir: config.workspacePath });
    registerAllTools(server, activeReader, bridge);
    registerAllResources(server, activeReader, bridge);

    return server;
}

/**
 * Boots up the MCP server with StdioServerTransport, local WebSocket bridge, and handles lifecycle signals.
 */
export async function runServer(config: McpServerConfig): Promise<void> {
    const reader = new WorkspaceReader({ workspaceDir: config.workspacePath });
    const bridge = new BridgeServer({
        workspacePath: config.workspacePath,
        serverVersion: config.serverVersion,
        reader,
        allowedOrigins: config.allowedOrigins,
        originMode: config.originMode
    });

    // Start local WebSocket bridge server for live browser synchronization
    await bridge.start();

    const server = createMcpServer(config, reader, bridge);
    const transport = new StdioServerTransport();

    // Signal and stream handlers for graceful termination
    let isTerminating = false;
    const shutdown = async () => {
        if (isTerminating) return;
        isTerminating = true;

        // Force exit safety timer (3s) to prevent hanging on stalled connections
        const forceExitTimer = setTimeout(() => process.exit(0), 3000);
        forceExitTimer.unref();

        try {
            await Promise.allSettled([
                server.close(),
                bridge.stop()
            ]);
        } catch {
            // Silently close
        } finally {
            clearTimeout(forceExitTimer);
            process.exit(0);
        }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.on('end', shutdown);
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
            shutdown();
        }
    });

    console.error(`[Noust MCP] Initializing server for workspace folder: ${config.workspacePath}`);
    await server.connect(transport);
    console.error(`[Noust MCP] Server connected via stdio transport with tools registered.`);
}
