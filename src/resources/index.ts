// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceReader } from '../workspace/WorkspaceReader.js';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type { GetStatusResult, ListObjectivesPayload } from '../bridge/types.js';
import type { NoustNote, NoustDocument, NoustObjective } from '../workspace/types.js';

/**
 * Formats a note entity into clean Markdown text for MCP resource consumption.
 */
function formatNoteMarkdown(note: NoustNote): string {
    const lines: string[] = [];
    if (note.title) {
        lines.push(`# ${note.title}\n`);
    }
    const metaParts: string[] = [];
    if (note.domainTitle || note.domainId) {
        metaParts.push(`Domain: ${note.domainTitle || note.domainId}`);
    }
    if (note.humanRef) {
        metaParts.push(`Canvas Ref: ${note.humanRef}`);
    }
    if (metaParts.length > 0) {
        lines.push(`> ${metaParts.join(' | ')}\n`);
    }
    lines.push((note.content as string) || '');
    return lines.join('\n');
}

/**
 * Formats a Nexus document entity into clean Markdown text for MCP resource consumption.
 */
function formatDocumentMarkdown(doc: NoustDocument): string {
    const lines: string[] = [];
    if (doc.title) {
        lines.push(`# ${doc.title}\n`);
    }
    lines.push((doc.content as string) || '');
    return lines.join('\n');
}

/**
 * Registers standard MCP Resources (resources/list and resources/read) on the server.
 * Allows client environments like Claude Desktop, Cursor, or IDEs to directly inspect
 * workspace overview, notes, and Nexus documents as readable context.
 */
export function registerAllResources(
    server: McpServer,
    reader: WorkspaceReader,
    bridge?: BridgeServer
): void {
    // 1. Static Resource: noust://workspace/active
    server.registerResource(
        'active-workspace',
        'noust://workspace/active',
        {
            title: 'Active Noust Workspace',
            description: 'Metadata, domains, note counts, and connection status of the active Noust workspace',
            mimeType: 'application/json'
        },
        async (uri) => {
            if (bridge && bridge.isConnected()) {
                try {
                    const status = await bridge.dispatchAction<Record<string, never>, GetStatusResult>(
                        'get_status',
                        {},
                        5000
                    );
                    return {
                        contents: [
                            {
                                uri: uri.href,
                                mimeType: 'application/json',
                                text: JSON.stringify(status, null, 2)
                            }
                        ]
                    };
                } catch {
                    // Fall back to offline file reader
                }
            }

            try {
                const ws = await reader.readWorkspace();
                const overview = {
                    workspaceId: ws.workspaceId,
                    workspaceName: ws.workspaceName,
                    domains: (ws.domains || []).map((d) => ({
                        id: d.id,
                        title: d.title,
                        noteCount: Array.isArray(d.notes) ? d.notes.length : 0
                    })),
                    totalNotes: (ws.domains || []).reduce(
                        (sum, d) => sum + (Array.isArray(d.notes) ? d.notes.length : 0),
                        0
                    ),
                    totalDocuments: Array.isArray(ws.globalFreeTextDocs)
                        ? ws.globalFreeTextDocs.length
                        : 0
                };

                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify(overview, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify({ error: `Failed to read workspace: ${message}` })
                        }
                    ]
                };
            }
        }
    );

    // 2. Dynamic Template Resource: noust://notes/{noteId}
    const noteTemplate = new ResourceTemplate('noust://notes/{noteId}', {
        list: async () => {
            try {
                const notes = await reader.getAllNotes();
                return {
                    resources: notes.map((n) => ({
                        uri: `noust://notes/${n.id}`,
                        name: n.title ? `Note: ${n.title}` : `Note ${n.id}`,
                        description: `Canvas note in domain "${n.domainTitle || n.domainId || 'General'}"${
                            n.humanRef ? ` (${n.humanRef})` : ''
                        }`,
                        mimeType: 'text/markdown'
                    }))
                };
            } catch {
                return { resources: [] };
            }
        }
    });

    server.registerResource(
        'note',
        noteTemplate,
        {
            title: 'Noust Note Content',
            description: 'Direct readable markdown content of a canvas note by ID or human reference',
            mimeType: 'text/markdown'
        },
        async (uri, variables) => {
            const rawId = Array.isArray(variables.noteId) ? variables.noteId[0] : variables.noteId;
            const noteId = String(rawId || '').trim();

            if (bridge && bridge.isConnected()) {
                try {
                    const liveNote = await bridge.dispatchAction<{ noteId: string }, NoustNote>(
                        'get_note',
                        { noteId },
                        5000
                    );
                    if (liveNote) {
                        return {
                            contents: [
                                {
                                    uri: uri.href,
                                    mimeType: 'text/markdown',
                                    text: formatNoteMarkdown(liveNote)
                                }
                            ]
                        };
                    }
                } catch {
                    // Fall back to offline reader
                }
            }

            const note = await reader.getNoteById(noteId);
            if (!note) {
                throw new Error(`Note "${noteId}" not found in active workspace.`);
            }

            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'text/markdown',
                        text: formatNoteMarkdown(note)
                    }
                ]
            };
        }
    );

    // 3. Dynamic Template Resource: noust://documents/{docId}
    const docTemplate = new ResourceTemplate('noust://documents/{docId}', {
        list: async () => {
            try {
                const docs = await reader.getAllDocuments();
                return {
                    resources: docs.map((d) => ({
                        uri: `noust://documents/${d.id}`,
                        name: d.title ? `Document: ${d.title}` : `Document ${d.id}`,
                        description: 'Nexus markdown document',
                        mimeType: 'text/markdown'
                    }))
                };
            } catch {
                return { resources: [] };
            }
        }
    });

    server.registerResource(
        'document',
        docTemplate,
        {
            title: 'Nexus Document Content',
            description: 'Direct readable markdown content of a Nexus document by ID',
            mimeType: 'text/markdown'
        },
        async (uri, variables) => {
            const rawId = Array.isArray(variables.docId) ? variables.docId[0] : variables.docId;
            const docId = String(rawId || '').trim();

            if (bridge && bridge.isConnected()) {
                try {
                    const liveDoc = await bridge.dispatchAction<{ docId: string }, NoustDocument>(
                        'get_document',
                        { docId },
                        5000
                    );
                    if (liveDoc) {
                        return {
                            contents: [
                                {
                                    uri: uri.href,
                                    mimeType: 'text/markdown',
                                    text: formatDocumentMarkdown(liveDoc)
                                }
                            ]
                        };
                    }
                } catch {
                    // Fall back to offline reader
                }
            }

            const doc = await reader.getDocumentById(docId);
            if (!doc) {
                throw new Error(`Nexus document "${docId}" not found in active workspace.`);
            }

            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'text/markdown',
                        text: formatDocumentMarkdown(doc)
                    }
                ]
            };
        }
    );

    // 4. Static Resource: noust://objectives/active
    server.registerResource(
        'active-objectives',
        'noust://objectives/active',
        {
            title: 'Active Workspace Objectives',
            description: 'List of all active goals, milestones, categories, and flags in the workspace',
            mimeType: 'application/json'
        },
        async (uri) => {
            if (bridge && bridge.isConnected()) {
                try {
                    const liveObjectives = await bridge.dispatchAction<ListObjectivesPayload, NoustObjective[]>(
                        'list_objectives',
                        {},
                        5000
                    );
                    if (Array.isArray(liveObjectives)) {
                        return {
                            contents: [
                                {
                                    uri: uri.href,
                                    mimeType: 'application/json',
                                    text: JSON.stringify(liveObjectives, null, 2)
                                }
                            ]
                        };
                    }
                } catch {
                    // Fall back to offline file reader
                }
            }

            try {
                const objectives = await reader.getAllObjectives();
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify(objectives, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify({ error: `Failed to read objectives: ${message}` })
                        }
                    ]
                };
            }
        }
    );
}
