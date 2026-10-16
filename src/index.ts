// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

export { createMcpServer, runServer } from './server.js';
export { parseCliArgs, validateCliOptions, printHelp, printVersion, SERVER_NAME, SERVER_VERSION } from './cli/args.js';
export { WorkspaceReader } from './workspace/WorkspaceReader.js';
export { BridgeServer } from './bridge/BridgeServer.js';
export {
    registerAllTools,
    registerSearchTool,
    registerNotesTools,
    registerAssetsTools,
    registerActionTools
} from './tools/index.js';
export { registerAllResources } from './resources/index.js';

export type { CliOptions, CliValidationResult, McpServerConfig } from './cli/types.js';
export type {
    NoustWorkspaceData,
    NoustNote,
    NoustDocument,
    NoustObjective,
    NoustDomain,
    CachedWorkspace,
    WorkspaceReaderOptions
} from './workspace/types.js';
export type {
    BridgeServerOptions,
    ConnectedClientMeta
} from './bridge/BridgeServer.js';
export type {
    McpActionType,
    ClientHelloPayload,
    ServerHelloPayload,
    ClientWorkspaceChangedPayload,
    BridgeActionRequest,
    BridgeActionResponse,
    CreateNotePayload,
    CreateNoteResult,
    UpdateNotePayload,
    UpdateNoteResult,
    DeleteNotePayload,
    DeleteNoteResult,
    FocusNotePayload,
    FocusNoteResult,
    FocusDocumentPayload,
    FocusDocumentResult,
    GetStatusResult,
    GetNotePayload,
    GetDocumentPayload,
    GetObjectivePayload,
    ListObjectivesPayload,
    SearchWorkspacePayload
} from './bridge/types.js';
