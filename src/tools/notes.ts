// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceReader } from '../workspace/WorkspaceReader.js';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type { NoustNote, NoustDocument, NoustObjective } from '../workspace/types.js';

/**
 * Registers `get_note`, `get_document`, and `get_objective` MCP tools.
 */
export function registerNotesTools(server: McpServer, reader: WorkspaceReader, bridge?: BridgeServer): void {
    // 1. Tool: get_note
    server.registerTool(
        'get_note',
        {
            title: 'Get Note by ID',
            description:
                'Retrieves the full content and metadata of a specific note by its ID or domain-qualified address from the active workspace.',
            inputSchema: {
                noteId: z.union([z.string(), z.number()]).describe('The unique system ID or domain-qualified human ID (e.g. "1A1", "2A1") of the note to retrieve'),
                workspace: z.string().optional().describe('Target workspace name or ID (required only when multiple workspaces are connected and current directory has no local .noust file)')
            }
        },
        async ({ noteId, workspace }) => {
            if (workspace && workspace.trim() !== '') {
                if (!bridge || !bridge.isConnected()) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Target workspace "${workspace}" is not accessible because the Noust browser bridge is not connected.` }]
                    };
                }
                try {
                    const result = await bridge.dispatchAction<{ noteId: string | number }, NoustNote>(
                        'get_note',
                        { noteId },
                        5000,
                        workspace
                    );
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result, null, 2)
                            }
                        ]
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Failed to retrieve note from target workspace "${workspace}": ${message}` }]
                    };
                }
            }

            if (bridge && bridge.isConnected()) {
                try {
                    const result = await bridge.dispatchAction<{ noteId: string | number }, NoustNote>(
                        'get_note',
                        { noteId },
                        5000
                    );
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result, null, 2)
                            }
                        ]
                    };
                } catch {
                    // Fall back to offline file reader if bridge call fails
                }
            }

            try {
                const note = await reader.getNoteById(noteId);
                if (!note) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Note with ID "${noteId}" not found in active workspace.`
                            }
                        ]
                    };
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(note, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to retrieve note: ${message}` }]
                };
            }
        }
    );

    // 2. Tool: get_document
    server.registerTool(
        'get_document',
        {
            title: 'Get Nexus Document by ID',
            description:
                'Retrieves the complete content and metadata of a Nexus markdown document by its ID from the active workspace.',
            inputSchema: {
                docId: z.union([z.string(), z.number()]).describe('The unique ID of the Nexus document to retrieve'),
                workspace: z.string().optional().describe('Target workspace name or ID (required only when multiple workspaces are connected and current directory has no local .noust file)')
            }
        },
        async ({ docId, workspace }) => {
            if (workspace && workspace.trim() !== '') {
                if (!bridge || !bridge.isConnected()) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Target workspace "${workspace}" is not accessible because the Noust browser bridge is not connected.` }]
                    };
                }
                try {
                    const result = await bridge.dispatchAction<{ docId: string | number }, NoustDocument>(
                        'get_document',
                        { docId },
                        5000,
                        workspace
                    );
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result, null, 2)
                            }
                        ]
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Failed to retrieve document from target workspace "${workspace}": ${message}` }]
                    };
                }
            }

            if (bridge && bridge.isConnected()) {
                try {
                    const result = await bridge.dispatchAction<{ docId: string | number }, NoustDocument>(
                        'get_document',
                        { docId },
                        5000
                    );
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result, null, 2)
                            }
                        ]
                    };
                } catch {
                    // Fall back to offline file reader if bridge call fails
                }
            }

            try {
                const doc = await reader.getDocumentById(docId);
                if (!doc) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Document with ID "${docId}" not found in active workspace.`
                            }
                        ]
                    };
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(doc, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to retrieve document: ${message}` }]
                };
            }
        }
    );

    // 3. Tool: get_objective
    server.registerTool(
        'get_objective',
        {
            title: 'Get Nexus Objective by ID',
            description:
                'Retrieves the complete metadata, linked notes, and status of a Nexus objective by its ID from the active workspace.',
            inputSchema: {
                objectiveId: z.union([z.string(), z.number()]).describe('The unique ID of the Nexus objective to retrieve'),
                workspace: z.string().optional().describe('Target workspace name or ID (required only when multiple workspaces are connected and current directory has no local .noust file)')
            }
        },
        async ({ objectiveId, workspace }) => {
            if (workspace && workspace.trim() !== '') {
                if (!bridge || !bridge.isConnected()) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Target workspace "${workspace}" is not accessible because the Noust browser bridge is not connected.` }]
                    };
                }
                try {
                    const result = await bridge.dispatchAction<{ objectiveId: string | number }, NoustObjective>(
                        'get_objective',
                        { objectiveId },
                        5000,
                        workspace
                    );
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result, null, 2)
                            }
                        ]
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Failed to retrieve objective from target workspace "${workspace}": ${message}` }]
                    };
                }
            }

            if (bridge && bridge.isConnected()) {
                try {
                    const result = await bridge.dispatchAction<{ objectiveId: string | number }, NoustObjective>(
                        'get_objective',
                        { objectiveId },
                        5000
                    );
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result, null, 2)
                            }
                        ]
                    };
                } catch {
                    // Fall back to offline file reader if bridge call fails
                }
            }

            try {
                const obj = await reader.getObjectiveById(objectiveId);
                if (!obj) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Objective with ID "${objectiveId}" not found in active workspace.`
                            }
                        ]
                    };
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(obj, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to retrieve objective: ${message}` }]
                };
            }
        }
    );
}


