// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceReader } from '../workspace/WorkspaceReader.js';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type { SearchWorkspaceResult } from '../bridge/types.js';
import type { NoustNote, NoustDocument, NoustObjective } from '../workspace/types.js';

/**
 * Strips HTML, CSS and entity markup identical to Atlas and Nexus Pages search in Noust.
 */
function cleanSearchText(raw: string): string {
    if (!raw) return '';
    if (!raw.includes('<') && !raw.includes('&')) return raw.trim();
    return raw
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]*>?/gm, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\u00a0/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Registers the `search_workspace` MCP tool.
 */
export function registerSearchTool(server: McpServer, reader: WorkspaceReader, bridge?: BridgeServer): void {
    server.registerTool(
        'search_workspace',
        {
            title: 'Search Workspace',
            description:
                'Searches across all notes, Nexus documents, and objectives within the active Noust workspace. ' +
                'Matches on human-visible text content (ignoring HTML/CSS tags, like Atlas search) and returns complete items.',
            inputSchema: {
                query: z.string().describe('Search keyword or phrase to look for (min 2 characters, case-insensitive)'),
                scope: z
                    .enum(['all', 'notes', 'documents', 'objectives'])
                    .default('all')
                    .describe('Filter search scope: "all" (default), "notes", "documents", or "objectives"'),
                limit: z.number().int().min(1).max(100).default(20).optional().describe('Maximum number of items to return per category (default: 20)'),
                offset: z.number().int().min(0).default(0).optional().describe('Number of matching items to skip for pagination (default: 0)'),
                workspace: z.string().optional().describe('Target workspace name or ID (required only when multiple workspaces are connected and current directory has no local .noust file)')
            }
        },
        async ({ query, scope, limit, offset, workspace }) => {
            const cleanQuery = query.trim().toLowerCase();
            if (cleanQuery.length < 2) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Search query must be at least 2 characters long.' }]
                };
            }

            if (workspace && workspace.trim() !== '') {
                if (!bridge || !bridge.isConnected()) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Target workspace "${workspace}" is not accessible because the Noust browser bridge is not connected.` }]
                    };
                }
                try {
                    const result = await bridge.dispatchAction<{ query: string; scope: string; limit?: number; offset?: number }, SearchWorkspaceResult>(
                        'search_workspace',
                        { query, scope, limit, offset },
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
                        content: [{ type: 'text', text: `Failed to search target workspace "${workspace}": ${message}` }]
                    };
                }
            }

            if (bridge && bridge.isConnected()) {
                try {
                    const result = await bridge.dispatchAction<{ query: string; scope: string; limit?: number; offset?: number }, SearchWorkspaceResult>(
                        'search_workspace',
                        { query, scope, limit, offset },
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
                    // Fall back to offline reader if bridge call fails
                }
            }

            try {
                const searchNotes = scope === 'all' || scope === 'notes';
                const searchDocs = scope === 'all' || scope === 'documents';
                const searchObjs = scope === 'all' || scope === 'objectives';

                const matchedNotes: Array<Record<string, unknown>> = [];
                const matchedDocs: Array<Record<string, unknown>> = [];
                const matchedObjs: Array<Record<string, unknown>> = [];

                if (searchNotes) {
                    const allNotes = await reader.getAllNotes();
                    for (const note of allNotes) {
                        const titleClean = cleanSearchText(note.title || '').toLowerCase();
                        const contentClean = cleanSearchText(note.content || '').toLowerCase();
                        const tagsMatch = Array.isArray(note.tags) &&
                            note.tags.some((tag) => String(tag).toLowerCase().includes(cleanQuery));

                        const refMatch = Boolean(
                            (note.humanRef && String(note.humanRef).toLowerCase().includes(cleanQuery)) ||
                            String(note.id).toLowerCase() === cleanQuery
                        );

                        if (titleClean.includes(cleanQuery) || contentClean.includes(cleanQuery) || tagsMatch || refMatch) {
                            matchedNotes.push({
                                id: note.id,
                                title: note.title || '',
                                content: note.content || '',
                                domainId: note.domainId,
                                domainTitle: note.domainTitle,
                                humanRef: typeof note.humanRef === 'string' ? note.humanRef : undefined,
                                tags: Array.isArray(note.tags) ? note.tags : undefined,
                                objectiveId: typeof note.objectiveId === 'string' || typeof note.objectiveId === 'number' ? note.objectiveId : undefined,
                                type: typeof note.type === 'string' ? note.type : undefined,
                                created: typeof note.created === 'string' ? note.created : undefined,
                                modified: typeof note.modified === 'string' ? note.modified : undefined
                            });
                        }
                    }
                }

                if (searchDocs) {
                    const allDocs = await reader.getAllDocuments();
                    for (const doc of allDocs) {
                        const titleClean = cleanSearchText(doc.title || '').toLowerCase();
                        const contentClean = cleanSearchText(doc.content || '').toLowerCase();

                        if (titleClean.includes(cleanQuery) || contentClean.includes(cleanQuery)) {
                            matchedDocs.push({
                                id: doc.id,
                                title: doc.title || '',
                                content: doc.content || '',
                                folderId: typeof doc.folderId === 'string' || typeof doc.folderId === 'number' ? doc.folderId : undefined,
                                created: typeof doc.created === 'string' ? doc.created : undefined,
                                modified: typeof doc.modified === 'string' ? doc.modified : undefined
                            });
                        }
                    }
                }

                if (searchObjs) {
                    const allObjs = await reader.getAllObjectives();
                    for (const obj of allObjs) {
                        const titleClean = cleanSearchText(obj.title || '').toLowerCase();
                        const descClean = cleanSearchText(obj.description || '').toLowerCase();

                        if (titleClean.includes(cleanQuery) || descClean.includes(cleanQuery)) {
                            matchedObjs.push({
                                id: obj.id,
                                title: obj.title || '',
                                description: obj.description || '',
                                done: Boolean(obj.done || obj.completed),
                                deadline: typeof obj.deadline === 'string' ? obj.deadline : (typeof obj.dueDate === 'string' ? obj.dueDate : undefined),
                                domainId: obj.domainId,
                                flags: Array.isArray(obj.flags) ? obj.flags : [],
                                inPath: typeof obj.inPath === 'boolean' ? obj.inPath : (typeof obj.inFlow === 'boolean' ? obj.inFlow : undefined),
                                priority: typeof obj.priority === 'string' || typeof obj.priority === 'boolean' ? obj.priority : undefined,
                                linkedNoteIds: Array.isArray(obj.linkedNoteIds) ? obj.linkedNoteIds : []
                            });
                        }
                    }
                }

                const totalMatches = matchedNotes.length + matchedDocs.length + matchedObjs.length;
                if (totalMatches === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No matches found for "${query}" (scope: ${scope}).`
                            }
                        ]
                    };
                }

                const pageLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 20;
                const pageOffset = typeof offset === 'number' && offset >= 0 ? offset : 0;

                const pagedNotes = matchedNotes.slice(pageOffset, pageOffset + pageLimit);
                const pagedDocs = matchedDocs.slice(pageOffset, pageOffset + pageLimit);
                const pagedObjs = matchedObjs.slice(pageOffset, pageOffset + pageLimit);

                const hasMore = (pageOffset + pageLimit < matchedNotes.length) ||
                                (pageOffset + pageLimit < matchedDocs.length) ||
                                (pageOffset + pageLimit < matchedObjs.length);

                const resultPayload = {
                    query,
                    scope,
                    totalMatches,
                    limit: pageLimit,
                    offset: pageOffset,
                    hasMore,
                    results: {
                        notes: pagedNotes,
                        documents: pagedDocs,
                        objectives: pagedObjs
                    }
                };

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(resultPayload, null, 2)
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Search failed: ${message}` }]
                };
            }
        }
    );
}
