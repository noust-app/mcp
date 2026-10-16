// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceReader } from '../workspace/WorkspaceReader.js';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type {
    CreateDocumentPayload,
    CreateDocumentResult,
    CreateFlagPayload,
    CreateFlagResult,
    CreateNotePayload,
    CreateNoteResult,
    CreateObjectivePayload,
    CreateObjectiveResult,
    DeleteDocumentPayload,
    DeleteDocumentResult,
    DeleteFlagPayload,
    DeleteFlagResult,
    DeleteNotePayload,
    DeleteNoteResult,
    DeleteObjectivePayload,
    DeleteObjectiveResult,
    FocusDocumentPayload,
    FocusDocumentResult,
    FocusNotePayload,
    FocusNoteResult,
    GetStatusResult,
    ListFlagsPayload,
    ListFlagsResult,
    UpdateDocumentPayload,
    UpdateDocumentResult,
    UpdateFlagPayload,
    UpdateFlagResult,
    UpdateNotePayload,
    UpdateNoteResult,
    UpdateObjectivePayload,
    UpdateObjectiveResult
} from '../bridge/types.js';

const OFFLINE_MUTATION_MESSAGE =
    'Interactive workspace actions require Noust to be running in your browser with the local WebSocket bridge connected (localhost:8421).\n' +
    'Please verify that Noust is open, File System Sync is configured for the workspace folder, and the MCP Bridge is enabled in Settings > Behavior > Workspace.';

async function getOfflineErrorMessage(bridge?: BridgeServer): Promise<string> {
    if (bridge) {
        return await bridge.getConnectionDiagnostic();
    }
    return OFFLINE_MUTATION_MESSAGE;
}

/**
 * Registers live workspace mutation and navigation MCP tools.
 */
export function registerActionTools(server: McpServer, reader: WorkspaceReader, bridge?: BridgeServer): void {
    // 1. Tool: get_workspace_status
    server.registerTool(
        'get_workspace_status',
        {
            title: 'Get Workspace Live & Sync Status',
            description:
                'Returns the current status of the workspace, including whether the Noust browser app is connected via local bridge, active domains, note counts, and all connected workspaces.',
            inputSchema: {
                workspace: z.string().optional().describe('Target workspace name or ID to query. If omitted, queries the local workspace or the active connected workspace.')
            }
        },
        async (args) => {
            let localWorkspace: { workspaceId?: string; workspaceName?: string } | null = null;
            try {
                const ws = await reader.readWorkspace();
                localWorkspace = {
                    workspaceId: typeof ws.workspaceId === 'string' ? ws.workspaceId : undefined,
                    workspaceName: typeof ws.workspaceName === 'string' ? ws.workspaceName : undefined
                };
            } catch {
                // No local workspace file in directory
            }

            const connectedWorkspaces = bridge ? bridge.getUniqueConnectedWorkspaces().map(w => ({
                workspaceId: w.workspaceId,
                workspaceName: w.workspaceName,
                folderName: w.folderName,
                activeDomainId: w.activeDomainId
            })) : [];

            if (args.workspace && args.workspace.trim() !== '') {
                if (!bridge || !bridge.isConnected()) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Target workspace "${args.workspace}" is not accessible because the Noust browser bridge is not connected.\n\nConnected workspaces: ${JSON.stringify(connectedWorkspaces, null, 2)}`
                            }
                        ]
                    };
                }
                try {
                    const status = await bridge.dispatchAction<Record<string, never>, GetStatusResult>(
                        'get_status',
                        {},
                        5000,
                        args.workspace
                    );
                    const enrichedStatus = {
                        ...status,
                        localWorkspace,
                        connectedWorkspaces
                    };
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(enrichedStatus, null, 2)
                            }
                        ]
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Failed to query live status from target workspace "${args.workspace}": ${message}\n\nConnected workspaces: ${JSON.stringify(connectedWorkspaces, null, 2)}`
                            }
                        ]
                    };
                }
            }

            if (bridge && bridge.isConnected()) {
                try {
                    const status = await bridge.dispatchAction<Record<string, never>, GetStatusResult>(
                        'get_status',
                        {},
                        5000
                    );
                    const enrichedStatus = {
                        ...status,
                        localWorkspace,
                        connectedWorkspaces
                    };
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(enrichedStatus, null, 2)
                            }
                        ]
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Failed to query live status from browser client: ${message}\n\nConnected workspaces: ${JSON.stringify(connectedWorkspaces, null, 2)}`
                            }
                        ]
                    };
                }
            }

            // Fallback: offline status from .noust file
            try {
                const workspace = await reader.readWorkspace();
                const rawDomains = workspace.domains;
                const domains = (Array.isArray(rawDomains) ? rawDomains : []).map((d) => ({
                    id: d.id,
                    title: d.title || 'Untitled',
                    noteCount: Array.isArray(d.notes) ? d.notes.length : 0
                }));
                const totalNotes = domains.reduce((sum: number, d) => sum + d.noteCount, 0);
                const totalDocuments = Array.isArray(workspace.globalFreeTextDocs)
                    ? workspace.globalFreeTextDocs.length
                    : 0;

                const workspaceName = typeof workspace.workspaceName === 'string'
                    ? workspace.workspaceName
                    : 'Offline Workspace';

                const diagnostic = bridge ? await bridge.getConnectionDiagnostic() : undefined;
                const offlineStatus = {
                    connected: false,
                    workspaceId: typeof workspace.workspaceId === 'string' ? workspace.workspaceId : 'offline',
                    workspaceName,
                    activeDomainId: domains[0]?.id || null,
                    domains,
                    totalNotes,
                    totalDocuments,
                    localWorkspace,
                    connectedWorkspaces,
                    bridgeDiagnostic: diagnostic
                };

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(offlineStatus, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const diagnostic = bridge ? await bridge.getConnectionDiagnostic() : undefined;
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: diagnostic
                                ? `Failed to read offline workspace file: ${message}\n\nBridge Diagnostic:\n${diagnostic}`
                                : `Bridge is offline and failed to read offline workspace file: ${message}`
                        }
                    ]
                };
            }
        }
    );

    // 2. Tool: create_note
    server.registerTool(
        'create_note',
        {
            title: 'Create Note in Workspace',
            description:
                'Creates a new note in the specified or active domain of the running Noust workspace. The note appears immediately on the user canvas. ALWAYS use this tool whenever the user asks to create, add, or write a note in Noust. NEVER edit .noust files directly on disk.',
            inputSchema: {
                title: z.string().optional().describe('Title of the new note (defaults to "New Note")'),
                content: z.string().optional().describe('Markdown or HTML content of the note'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Target domain ID. If omitted, placed in active domain.'),
                x: z.number().optional().describe('Canvas X coordinate (logical pixels)'),
                y: z.number().optional().describe('Canvas Y coordinate (logical pixels)'),
                width: z.number().min(40).max(5000).optional().describe('Note width in pixels (minimum 40, maximum 5000, default 230)'),
                height: z.number().min(40).max(5000).optional().describe('Note height in pixels (minimum 40, maximum 5000, default 200)'),
                focus: z.boolean().optional().describe('Whether to center and highlight the created note on screen (default: true)'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: CreateNotePayload = {
                    title: args.title,
                    content: args.content,
                    domainId: args.domainId,
                    x: args.x,
                    y: args.y,
                    width: args.width,
                    height: args.height,
                    focus: args.focus ?? true
                };

                const result = await bridge.dispatchAction<CreateNotePayload, CreateNoteResult>(
                    'create_note',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully created note "${result.title}" (ID: ${result.noteId}) in domain "${result.domainId}".`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to create note: ${message}` }]
                };
            }
        }
    );

    // 3. Tool: update_note
    server.registerTool(
        'update_note',
        {
            title: 'Update Existing Note',
            description:
                'Updates the title, replaces content, or appends text to an existing note in the active Noust workspace in real-time. Use the "append" parameter to add text to the end of a note in a single step without needing to read it first. ALWAYS use this tool whenever the user asks to modify, edit, append to, or update any note in Noust. NEVER edit .noust files directly on disk.',
            inputSchema: {
                noteId: z.union([z.string(), z.number()]).describe('Unique system ID or domain-qualified human ID (e.g. "1A1", "2A1") of the note to update'),
                title: z.string().optional().describe('New title for the note'),
                content: z.string().optional().describe('New Markdown or HTML content to replace existing note content'),
                append: z.string().optional().describe('Markdown or HTML text to append to the end of the existing note content (avoids having to read the note first)'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Domain ID where the note is located'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            if (args.title === undefined && args.content === undefined && args.append === undefined) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'At least one of "title", "content", or "append" must be provided to update the note.' }]
                };
            }

            try {
                const payload: UpdateNotePayload = {
                    noteId: args.noteId,
                    title: args.title,
                    content: args.content,
                    append: args.append,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<UpdateNotePayload, UpdateNoteResult>(
                    'update_note',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully updated note "${result.noteId}" in active Noust workspace.`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to update note: ${message}` }]
                };
            }
        }
    );

    // 4. Tool: delete_note
    server.registerTool(
        'delete_note',
        {
            title: 'Delete Note',
            description:
                'Deletes a note by its ID from the active Noust workspace in real-time.',
            inputSchema: {
                noteId: z.union([z.string(), z.number()]).describe('Unique system ID or domain-qualified human ID (e.g. "1A1", "2A1") of the note to delete'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Domain ID where the note is located'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: DeleteNotePayload = {
                    noteId: args.noteId,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<DeleteNotePayload, DeleteNoteResult>(
                    'delete_note',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully deleted note "${result.noteId}" from active Noust workspace.`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to delete note: ${message}` }]
                };
            }
        }
    );

    // 5. Tool: focus_note
    server.registerTool(
        'focus_note',
        {
            title: 'Focus Note on Canvas',
            description:
                'Pans and zooms the canvas to center on a note and applies a visual glow highlight to draw the user’s attention.',
            inputSchema: {
                noteId: z.union([z.string(), z.number()]).describe('Unique system ID or domain-qualified human ID (e.g. "1A1", "2A1") of the note to focus'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: FocusNotePayload = { noteId: args.noteId };
                const result = await bridge.dispatchAction<FocusNotePayload, FocusNoteResult>(
                    'focus_note',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Canvas viewport centered and focused on note "${result.noteId}".`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to focus note: ${message}` }]
                };
            }
        }
    );

    // 6. Tool: focus_document
    server.registerTool(
        'focus_document',
        {
            title: 'Open and Focus Nexus Document',
            description:
                'Opens the Nexus Pages panel and activates the specified document for the user.',
            inputSchema: {
                docId: z.union([z.string(), z.number()]).describe('Unique ID of the Nexus document to open'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: FocusDocumentPayload = { docId: args.docId };
                const result = await bridge.dispatchAction<FocusDocumentPayload, FocusDocumentResult>(
                    'focus_document',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Nexus document "${result.docId}" opened and focused in view.`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to open document: ${message}` }]
                };
            }
        }
    );

    // 7. Tool: create_objective
    server.registerTool(
        'create_objective',
        {
            title: 'Create Objective in Workspace',
            description:
                'Creates a new objective in the active or specified domain of the running Noust workspace. Optionally links notes, assigns deadlines, priority, and flow inclusion.',
            inputSchema: {
                title: z.string().describe('Title of the objective'),
                description: z.string().optional().describe('Detailed description or criteria for the objective'),
                linkedNoteIds: z.array(z.union([z.string(), z.number()])).optional().describe('List of note IDs to link to this objective'),
                deadline: z.string().optional().describe('Deadline for the objective (e.g. "YYYY-MM-DD")'),
                priority: z.boolean().optional().describe('Whether this objective has high priority'),
                inPath: z.boolean().optional().describe('Whether this objective is included in Nexus Path'),
                flagIds: z.array(z.string()).optional().describe('List of flag tags to attach to the objective'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Domain ID where the objective should be created'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: CreateObjectivePayload = {
                    title: args.title,
                    description: args.description,
                    linkedNoteIds: args.linkedNoteIds,
                    deadline: args.deadline,
                    priority: args.priority,
                    inPath: args.inPath,
                    flagIds: args.flagIds,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<CreateObjectivePayload, CreateObjectiveResult>(
                    'create_objective',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully created objective "${result.title}" (ID: ${result.objectiveId}) in domain "${result.domainId}".`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to create objective: ${message}` }]
                };
            }
        }
    );

    // 8. Tool: update_objective
    server.registerTool(
        'update_objective',
        {
            title: 'Update Existing Objective',
            description:
                'Modifies an existing objective in the active Noust workspace: edit title, replace or append description, toggle/mark completed, set deadline or priority, and link/unlink notes.',
            inputSchema: {
                objectiveId: z.union([z.string(), z.number()]).describe('Unique ID of the objective to update'),
                title: z.string().optional().describe('New title for the objective'),
                description: z.string().optional().describe('New description to replace existing description'),
                appendDescription: z.string().optional().describe('Text to append to the end of the existing description'),
                done: z.boolean().optional().describe('Set completion status to true or false'),
                toggleDone: z.boolean().optional().describe('Toggle current completion status'),
                deadline: z.string().optional().describe('New deadline string (e.g. "YYYY-MM-DD")'),
                priority: z.boolean().optional().describe('Set priority status'),
                inPath: z.boolean().optional().describe('Set inclusion in Nexus Path'),
                flagIds: z.array(z.string()).optional().describe('Update flag tags attached to the objective'),
                linkNoteIds: z.array(z.union([z.string(), z.number()])).optional().describe('Note IDs to add to linked notes'),
                unlinkNoteIds: z.array(z.union([z.string(), z.number()])).optional().describe('Note IDs to remove from linked notes'),
                linkedNoteIds: z.array(z.union([z.string(), z.number()])).optional().describe('Complete replacement list of linked note IDs'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Domain ID if known'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            if (
                args.title === undefined &&
                args.description === undefined &&
                args.appendDescription === undefined &&
                args.done === undefined &&
                args.toggleDone === undefined &&
                args.deadline === undefined &&
                args.priority === undefined &&
                args.inPath === undefined &&
                args.flagIds === undefined &&
                args.linkNoteIds === undefined &&
                args.unlinkNoteIds === undefined &&
                args.linkedNoteIds === undefined
            ) {
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: 'At least one field to update must be provided (e.g. title, description, appendDescription, done, toggleDone, deadline, priority, inPath, linkNoteIds, etc.).'
                        }
                    ]
                };
            }

            try {
                const payload: UpdateObjectivePayload = {
                    objectiveId: args.objectiveId,
                    title: args.title,
                    description: args.description,
                    appendDescription: args.appendDescription,
                    done: args.done,
                    toggleDone: args.toggleDone,
                    deadline: args.deadline,
                    priority: args.priority,
                    inPath: args.inPath,
                    flagIds: args.flagIds,
                    linkNoteIds: args.linkNoteIds,
                    unlinkNoteIds: args.unlinkNoteIds,
                    linkedNoteIds: args.linkedNoteIds,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<UpdateObjectivePayload, UpdateObjectiveResult>(
                    'update_objective',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully updated objective "${result.objectiveId}".`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to update objective: ${message}` }]
                };
            }
        }
    );

    // 9. Tool: delete_objective
    server.registerTool(
        'delete_objective',
        {
            title: 'Delete Objective',
            description:
                'Deletes an objective by its ID from the active Noust workspace in real-time.',
            inputSchema: {
                objectiveId: z.union([z.string(), z.number()]).describe('Unique ID of the objective to delete'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Domain ID if known'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: DeleteObjectivePayload = {
                    objectiveId: args.objectiveId,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<DeleteObjectivePayload, DeleteObjectiveResult>(
                    'delete_objective',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully deleted objective "${result.objectiveId}" from workspace.`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to delete objective: ${message}` }]
                };
            }
        }
    );

    // 10. Tool: create_document
    server.registerTool(
        'create_document',
        {
            title: 'Create Nexus Page / Document',
            description:
                'Creates a new markdown page/document in Nexus Pages of the running Noust workspace.',
            inputSchema: {
                title: z.string().optional().describe('Title of the new document (defaults to "New Page")'),
                content: z.string().optional().describe('Markdown content of the document'),
                folderId: z.string().optional().describe('ID of folder in Nexus to place the document in'),
                focus: z.boolean().optional().describe('Whether to open and focus the created document in Nexus view (default: false)'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: CreateDocumentPayload = {
                    title: args.title,
                    content: args.content,
                    folderId: args.folderId,
                    focus: args.focus
                };

                const result = await bridge.dispatchAction<CreateDocumentPayload, CreateDocumentResult>(
                    'create_document',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully created Nexus document "${result.title}" (ID: ${result.docId}).`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to create document: ${message}` }]
                };
            }
        }
    );

    // 11. Tool: update_document
    server.registerTool(
        'update_document',
        {
            title: 'Update Nexus Document',
            description:
                'Updates the title, replaces content, or appends text to an existing Nexus markdown page in real-time. Use the "append" parameter to add content to the end of a document in a single step.',
            inputSchema: {
                docId: z.union([z.string(), z.number()]).describe('Unique ID of the Nexus document to update'),
                title: z.string().optional().describe('New title for the document'),
                content: z.string().optional().describe('New markdown content to replace existing document content'),
                append: z.string().optional().describe('Markdown text to append to the end of the document (single-step execution)'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            if (args.title === undefined && args.content === undefined && args.append === undefined) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'At least one of "title", "content", or "append" must be provided to update the document.' }]
                };
            }

            try {
                const payload: UpdateDocumentPayload = {
                    docId: args.docId,
                    title: args.title,
                    content: args.content,
                    append: args.append
                };

                const result = await bridge.dispatchAction<UpdateDocumentPayload, UpdateDocumentResult>(
                    'update_document',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully updated Nexus document "${result.docId}".`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to update document: ${message}` }]
                };
            }
        }
    );

    // 12. Tool: delete_document
    server.registerTool(
        'delete_document',
        {
            title: 'Delete Nexus Document',
            description:
                'Deletes a Nexus markdown document by its ID from the active Noust workspace in real-time.',
            inputSchema: {
                docId: z.union([z.string(), z.number()]).describe('Unique ID of the Nexus document to delete'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: DeleteDocumentPayload = {
                    docId: args.docId
                };

                const result = await bridge.dispatchAction<DeleteDocumentPayload, DeleteDocumentResult>(
                    'delete_document',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully deleted Nexus document "${result.docId}".`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to delete document: ${message}` }]
                };
            }
        }
    );

    // 14. Tool: list_flags
    server.registerTool(
        'list_flags',
        {
            title: 'List Flags in Workspace Domain',
            description:
                'Retrieves all reusable flags/tags and their associated hexadecimal colors in the active or specified domain. Use this to inspect existing flag colors before creating a new flag with a distinct shade, or to obtain flag IDs for objectives.',
            inputSchema: {
                domainId: z.union([z.string(), z.number()]).optional().describe('Target domain ID. If omitted, returns flags from the active domain.'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (bridge && bridge.isConnected()) {
                try {
                    const payload: ListFlagsPayload = { domainId: args.domainId };
                    const result = await bridge.dispatchAction<ListFlagsPayload, ListFlagsResult>(
                        'list_flags',
                        payload,
                        5000,
                        args.workspace
                    );
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result.flags, null, 2)
                            }
                        ]
                    };
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Failed to list flags via bridge: ${message}` }]
                    };
                }
            }

            // Offline reading mode
            try {
                const flags = await reader.getFlags(args.domainId);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(flags, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to read flags offline: ${message}` }]
                };
            }
        }
    );

    // 15. Tool: create_flag
    server.registerTool(
        'create_flag',
        {
            title: 'Create Flag in Domain',
            description:
                'Creates a new reusable flag in the active or specified domain with a label and optional hexadecimal color. If color is omitted, an unused distinctive color is generated automatically. To ensure a requested color (e.g. a shade of orange) is distinct from existing flags in the domain, call list_flags first to inspect currently used colors.',
            inputSchema: {
                label: z.string().min(1).max(20).describe('The text label/name for the flag (e.g. "P0", "Design", "Bug"). Maximum 20 characters.'),
                color: z.string().optional().describe('Hexadecimal color code (e.g. "#F97316", "#FFA500"). If omitted, a distinct color is chosen automatically.'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Target domain ID. If omitted, created in active domain.'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: CreateFlagPayload = {
                    label: args.label,
                    color: args.color,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<CreateFlagPayload, CreateFlagResult>(
                    'create_flag',
                    payload,
                    5000,
                    args.workspace
                );

                const statusText = result.alreadyExists
                    ? `Flag "${result.label}" already exists with color ${result.color} (ID: ${result.flagId}) in domain "${result.domainId}".`
                    : `Successfully created flag "${result.label}" with color ${result.color} (ID: ${result.flagId}) in domain "${result.domainId}".`;

                return {
                    content: [
                        {
                            type: 'text',
                            text: statusText
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to create flag: ${message}` }]
                };
            }
        }
    );

    // 16. Tool: update_flag
    server.registerTool(
        'update_flag',
        {
            title: 'Update Flag in Domain',
            description:
                'Updates the label text and/or hexadecimal color of an existing reusable flag in the active or specified domain without changing its ID or affecting linked objectives. At least one of "label" or "color" must be provided.',
            inputSchema: {
                flagId: z.string().describe('The unique ID or the current exact label of the flag to update'),
                label: z.string().min(1).max(20).optional().describe('New text label for the flag (maximum 20 characters)'),
                color: z.string().optional().describe('New hexadecimal color code (e.g. "#F97316", "#10B981")'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Target domain ID if known'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            if (!args.label && !args.color) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'At least one of "label" or "color" must be specified to update a flag.' }]
                };
            }

            try {
                const payload: UpdateFlagPayload = {
                    flagId: args.flagId,
                    label: args.label,
                    color: args.color,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<UpdateFlagPayload, UpdateFlagResult>(
                    'update_flag',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Successfully updated flag "${result.label}" with color ${result.color} (ID: ${result.flagId}) in domain "${result.domainId}".`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to update flag: ${message}` }]
                };
            }
        }
    );

    // 17. Tool: delete_flag
    server.registerTool(
        'delete_flag',
        {
            title: 'Delete Flag from Domain',
            description:
                'Permanently removes a flag from the active or specified domain, and automatically unassigns it from any objectives or milestones that referenced it.',
            inputSchema: {
                flagId: z.string().describe('The unique ID or the exact name/label of the flag to delete (e.g. "Bug", "P0")'),
                domainId: z.union([z.string(), z.number()]).optional().describe('Target domain ID if known'),
                workspace: z.string().optional().describe('Target workspace name, ID, or directory path. If omitted, targets the workspace in the current working directory.')
            }
        },
        async (args) => {
            if (!bridge || !bridge.isConnected()) {
                const errorMsg = await getOfflineErrorMessage(bridge);
                return {
                    isError: true,
                    content: [{ type: 'text', text: errorMsg }]
                };
            }

            try {
                const payload: DeleteFlagPayload = {
                    flagId: args.flagId,
                    domainId: args.domainId
                };

                const result = await bridge.dispatchAction<DeleteFlagPayload, DeleteFlagResult>(
                    'delete_flag',
                    payload,
                    5000,
                    args.workspace
                );

                return {
                    content: [
                        {
                            type: 'text',
                            text: result.deleted
                                ? `Successfully deleted flag "${result.flagId}".`
                                : `Flag "${result.flagId}" was not found or was already deleted.`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to delete flag: ${message}` }]
                };
            }
        }
    );
}

