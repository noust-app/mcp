// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

export const DEFAULT_BRIDGE_PORT = 8421;
export const DEFAULT_BRIDGE_HOST = '127.0.0.1';

/**
 * Supported real-time actions dispatched from MCP to connected Noust client.
 */
export type McpActionType =
    | 'get_status'
    | 'get_note'
    | 'get_document'
    | 'get_objective'
    | 'list_objectives'
    | 'search_workspace'
    | 'create_note'
    | 'update_note'
    | 'delete_note'
    | 'focus_note'
    | 'focus_document'
    | 'create_objective'
    | 'update_objective'
    | 'delete_objective'
    | 'create_document'
    | 'update_document'
    | 'delete_document'
    | 'list_flags'
    | 'create_flag'
    | 'update_flag'
    | 'delete_flag';

/**
 * Handshake payload sent by the browser client upon connection.
 */
export interface ClientHelloPayload {
    type: 'client:hello';
    workspaceId: string;
    workspaceName: string;
    folderName?: string;
    activeDomainId?: string | number | null;
    token?: string;
}

/**
 * Notification payload sent by browser when active workspace changes.
 */
export interface ClientWorkspaceChangedPayload {
    type: 'client:workspace_changed';
    workspaceId: string;
    workspaceName: string;
    folderName?: string;
    activeDomainId?: string | number | null;
}

/**
 * Handshake response sent by BridgeServer to client.
 */
export interface ServerHelloPayload {
    type: 'server:hello';
    status: 'connected';
    workspacePath: string;
    serverVersion: string;
}

/**
 * Envelope for action requests sent from BridgeServer to browser client.
 */
export interface BridgeActionRequest<T = unknown> {
    id: string;
    action: McpActionType;
    payload: T;
}

/**
 * Envelope for action responses sent from browser client back to BridgeServer.
 */
export interface BridgeActionResponse<R = unknown> {
    id: string;
    success: boolean;
    result?: R;
    error?: string;
}

/**
 * Generic incoming message from browser client.
 */
export type ClientMessage =
    | ClientHelloPayload
    | ClientWorkspaceChangedPayload
    | BridgeActionResponse;

/**
 * Action Payloads & Results
 */

export interface CreateNotePayload {
    title?: string;
    content?: string;
    domainId?: string | number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    focus?: boolean;
}

export interface CreateNoteResult {
    noteId: string | number;
    title: string;
    domainId: string | number;
    x?: number;
    y?: number;
}

export interface UpdateNotePayload {
    noteId: string | number;
    title?: string;
    content?: string;
    append?: string;
    domainId?: string | number;
}

export interface UpdateNoteResult {
    noteId: string | number;
    updated: boolean;
}

export interface DeleteNotePayload {
    noteId: string | number;
    domainId?: string | number;
}

export interface DeleteNoteResult {
    noteId: string | number;
    deleted: boolean;
}

export interface FocusNotePayload {
    noteId: string | number;
}

export interface FocusNoteResult {
    noteId: string | number;
    focused: boolean;
}

export interface FocusDocumentPayload {
    docId: string | number;
}

export interface FocusDocumentResult {
    docId: string | number;
    focused: boolean;
}

export interface GetStatusResult {
    connected: boolean;
    workspaceId: string;
    workspaceName: string;
    activeDomainId?: string | number | null;
    domains: Array<{
        id: string | number;
        title: string;
        noteCount: number;
    }>;
    totalNotes: number;
    totalDocuments: number;
}

export interface CreateObjectivePayload {
    title: string;
    description?: string;
    linkedNoteIds?: (string | number)[];
    flagIds?: string[];
    inPath?: boolean;
    deadline?: string;
    priority?: boolean;
    domainId?: string | number;
}

export interface CreateObjectiveResult {
    objectiveId: string | number;
    title: string;
    domainId: string | number;
    linkedNoteIds: (string | number)[];
    inPath: boolean;
}

export interface UpdateObjectivePayload {
    objectiveId: string | number;
    title?: string;
    description?: string;
    appendDescription?: string;
    done?: boolean;
    toggleDone?: boolean;
    deadline?: string;
    priority?: boolean;
    inPath?: boolean;
    flagIds?: string[];
    linkedNoteIds?: (string | number)[];
    linkNoteIds?: (string | number)[];
    unlinkNoteIds?: (string | number)[];
    domainId?: string | number;
}

export interface UpdateObjectiveResult {
    objectiveId: string | number;
    updated: boolean;
    done?: boolean;
    inPath?: boolean;
}

export interface DeleteObjectivePayload {
    objectiveId: string | number;
    domainId?: string | number;
}

export interface DeleteObjectiveResult {
    objectiveId: string | number;
    deleted: boolean;
}

export interface CreateDocumentPayload {
    title?: string;
    content?: string;
    folderId?: string;
    focus?: boolean;
}

export interface CreateDocumentResult {
    docId: string | number;
    title: string;
    folderId?: string;
    focused: boolean;
}

export interface UpdateDocumentPayload {
    docId: string | number;
    title?: string;
    content?: string;
    append?: string;
}

export interface UpdateDocumentResult {
    docId: string | number;
    updated: boolean;
}

export interface DeleteDocumentPayload {
    docId: string | number;
}

export interface DeleteDocumentResult {
    docId: string | number;
    deleted: boolean;
}

export interface McpFlagItem {
    id: string;
    label: string;
    color: string;
    order: number;
    domainId?: string | number;
}

export interface ListFlagsPayload {
    domainId?: string | number;
}

export interface ListFlagsResult {
    flags: McpFlagItem[];
    domainId: string | number | null;
}

export interface CreateFlagPayload {
    label: string;
    color?: string;
    domainId?: string | number;
}

export interface CreateFlagResult {
    flagId: string;
    label: string;
    color: string;
    domainId: string | number;
    alreadyExists?: boolean;
}

export interface UpdateFlagPayload {
    flagId: string;
    label?: string;
    color?: string;
    domainId?: string | number;
}

export interface UpdateFlagResult {
    flagId: string;
    label: string;
    color: string;
    domainId: string | number;
    updated: boolean;
}

export interface DeleteFlagPayload {
    flagId: string;
    domainId?: string | number;
}

export interface DeleteFlagResult {
    flagId: string;
    deleted: boolean;
}

export interface GetNotePayload {
    noteId: string | number;
}

export interface GetDocumentPayload {
    docId: string | number;
}

export interface GetObjectivePayload {
    objectiveId?: string | number;
}

export interface ListObjectivesPayload {
    domainId?: string | number;
}

export interface SearchWorkspacePayload {
    query: string;
    scope?: 'all' | 'notes' | 'documents' | 'objectives';
    limit?: number;
    offset?: number;
}

export interface SearchWorkspaceResult {
    query: string;
    scope: string;
    totalMatches: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    results: {
        notes: Array<Record<string, unknown>>;
        documents: Array<Record<string, unknown>>;
        objectives: Array<Record<string, unknown>>;
    };
}

