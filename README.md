# @noust-app/mcp

> Official Model Context Protocol (MCP) server for [Noust](https://noust.app) workspaces.

`@noust-app/mcp` connects AI assistants—including **Claude Desktop**, **Cursor**, **Antigravity**, **Windsurf**, and **VS Code**—directly to your local Noust notes, canvas, Nexus documents, objectives, and media assets.

---

## Key Features

- **Dual-Mode Architecture**:
  - **Offline / File-Only Mode**: When Noust is closed, AI models can read notes, search workspaces, and inspect multimodal image assets directly from the local `.noust` file on disk.
  - **Live Bridge Mode (Zero-Trust)**: When Noust is open in your browser, a secure local WebSocket bridge (`127.0.0.1:8421`) activates automatically. AI agents can create notes, edit documents, manage objectives, adjust flags, and pan/highlight canvas cards in real time.
- **20 Comprehensive MCP Tools**: Full coverage across search, canvas notes, Nexus pages, milestone objectives, and color-coded flags.
- **4 Standard MCP Resources**: Exposes workspace overviews, canvas notes formatted as clean Markdown, Nexus documents, and active objectives directly as protocol resources (`noust://`) with automatic client discovery (`resources/list`).
- **Zero-Trust Security**:
  - Strictly bound to `127.0.0.1` (loopback only, never exposed to LAN).
  - Protected against Cross-Site WebSocket Hijacking (CSWSH) and DNS Rebinding.
  - Ephemeral shared-secret token (`.noust-bridge.token`) with restricted file permissions (`0600`) ensures only authorized local workspace tabs can interact with the server.
  - Automatic DOMPurify sanitization on all agent-generated content.
- **Standard Protocol Compliance**:
  - Built with `@modelcontextprotocol/sdk` adhering to the official Model Context Protocol specification.
  - Operates cleanly over standard input/output (`stdio`).

---

## Important: Cloud AI Models & Data Privacy

> [!WARNING]
> **Cloud AI Models & Data Privacy Notice**
> While Noust and `@noust-app/mcp` operate 100% locally on your machine (`127.0.0.1`) and never transmit your notes or data to Noust servers, any information read or retrieved by MCP tools (`search_workspace`, `get_note`, `get_document`, `get_objective`, etc.) becomes prompt context for your connected AI assistant.
>
> If your assistant connects to third-party cloud models (such as Claude/Anthropic, ChatGPT/OpenAI, or Gemini/Google), the retrieved workspace contents are sent over the internet to that model provider's servers according to their respective privacy policies and retention terms.
>
> If you require absolute data sovereignty or work with strictly confidential data, configure your MCP client to use local, self-hosted LLMs (e.g., via Ollama, LM Studio, or local open-source models).

---

## Prerequisites

1. **Node.js** `>= 18.0.0`
2. **Noust Workspace with Local Saving**:
   - Open [Noust](https://noust.app) in a Chromium browser (Chrome, Edge, Brave).
   - In the workspace drawer, link a local folder (Automatic Local Sync / File System Access API) to save your `.noust` files to disk.

---

## Installation & Configuration

You do **not** need to install `@noust-app/mcp` globally. MCP clients execute it on demand via `npx`.

### 1. Claude Desktop

Add `noust` to your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "noust": {
      "command": "npx",
      "args": [
        "-y",
        "@noust-app/mcp",
        "--workspace",
        "/absolute/path/to/your/noust-workspace-folder"
      ]
    }
  }
}
```

> [!TIP]
> **Windows Note**: In JSON configuration files, Windows paths must use escaped backslashes (e.g. `"C:\\Users\\Username\\Documents\\Noust"`) or forward slashes (e.g. `"C:/Users/Username/Documents/Noust"`) to avoid syntax errors.

Restart Claude Desktop. You will see the hammer icon with Noust's **20 tools** available.

---

### 2. Cursor IDE

Add `noust` to your project's `.cursor/mcp.json` or globally in **Settings > Features > MCP Servers**:

```json
{
  "mcpServers": {
    "noust": {
      "command": "npx",
      "args": [
        "-y",
        "@noust-app/mcp",
        "--workspace",
        "/absolute/path/to/your/noust-workspace-folder"
      ]
    }
  }
}
```

---

### 3. Antigravity IDE

Add `noust` to your `mcp_config.json`:

```json
{
  "mcpServers": {
    "noust": {
      "command": "npx",
      "args": [
        "-y",
        "@noust-app/mcp",
        "--workspace",
        "/absolute/path/to/your/noust-workspace-folder"
      ]
    }
  }
}
```

---

## Command Line Options

```bash
npx @noust-app/mcp --workspace <path-to-folder> [options]
```

| Option | Shorthand | Description | Default |
| :--- | :--- | :--- | :--- |
| `--workspace <path>` | `-w <path>` | Path to the linked local Noust folder | *(Required)* |
| `--allowed-origins <origins>` | | Comma-separated list of browser origins (requires `-d` or `-r`) | `https://noust.app, localhost` |
| `--add` | `-d` | Add specified origins to the default whitelist | |
| `--replace` | `-r` | Replace the default whitelist with the specified origins | |
| `--help` | `-h` | Display usage instructions | |
| `--version` | `-v` | Display server version | |

```bash
# Add a local dev origin while keeping official noust.app and localhost
npx @noust-app/mcp -w ~/Documents/NoustExports --allowed-origins http://localhost:5173 -d

# Replace default whitelist entirely with a private self-hosted domain
npx @noust-app/mcp -w ~/Documents/NoustExports --allowed-origins https://notes.internal.corp -r
```

---

## Available MCP Tools (20 Tools)

`noust-mcp` exposes 20 official tools categorized across inspection, search, canvas, documents, objectives, and flow flags:

### 1. Search & Inspection (Online & Offline)

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `search_workspace` | `query` *(string)*<br>`scope` *(enum: all, notes, documents, objectives)* | Searches across all notes, Nexus markdown documents, and objectives. Strips HTML/formatting for exact textual matching without truncation. |
| `get_note` | `noteId` *(string/number)* | Retrieves the complete content, domain location, dimensions, and metadata of a note. Supports human references (e.g. `1A1`). |
| `get_document` | `docId` *(string)* | Retrieves the complete markdown content and metadata of a Nexus free-text page/document. |
| `get_objective` | `objectiveId` *(string/number)*<br>`domainId` *(string/number, optional)* | Retrieves full details of an objective, including linked notes, deadline, priority, completion state, and attached flags. |
| `get_asset` | `hash` *(string)* | Retrieves an embedded image or media asset by its hash. Vision-capable models receive image data natively (`image/png`, `image/jpeg`, `image/webp`). |
| `get_workspace_status` | *(none)* | Returns real-time connection status, workspace metadata, active domains, and total note/doc counts. |

---

### 2. Canvas Notes (Live Bridge)

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `create_note` | `title` *(string, optional)*<br>`content` *(string, optional)*<br>`domainId` *(string/number, optional)*<br>`x`, `y` *(numbers, optional)*<br>`width`, `height` *(numbers, optional)*<br>`focus` *(boolean, default: true)* | Creates a new note card on the canvas with automatic positioning and sanitization. |
| `update_note` | `noteId` *(string/number)*<br>`title` *(string, optional)*<br>`content` *(string, optional)*<br>`append` *(string, optional)*<br>`domainId` *(string/number, optional)* | Updates title or content of an existing note, or appends text to the end of a note in a single step with live canvas re-rendering. |
| `delete_note` | `noteId` *(string/number)*<br>`domainId` *(string/number, optional)* | Removes a note from the canvas and workspace. |
| `focus_note` | `noteId` *(string/number)* | Pans and zooms the canvas to center on a note and applies a visual glow highlight. |

---

### 3. Nexus Pages & Documents (Live Bridge)

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `create_document` | `title` *(string, optional)*<br>`content` *(string, optional)*<br>`folderId` *(string, optional)*<br>`focus` *(boolean, optional)* | Creates a new markdown page/document in Nexus Pages of the running workspace. |
| `update_document` | `docId` *(string)*<br>`title` *(string, optional)*<br>`content` *(string, optional)*<br>`append` *(string, optional)*<br>`focus` *(boolean, optional)* | Updates an existing Nexus document. Supports appending content cleanly in a single step to log progress or append notes. |
| `delete_document` | `docId` *(string)* | Permanently deletes a Nexus document from the workspace. |
| `focus_document` | `docId` *(string/number)* | Opens the Nexus Pages side panel and focuses the requested document. |

---

### 4. Objectives & Nexus Path (Live Bridge)

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `create_objective` | `title` *(string)*<br>`description` *(string, optional)*<br>`linkedNoteIds` *(array, optional)*<br>`deadline` *(string, optional)*<br>`priority` *(boolean, optional)*<br>`inPath` *(boolean, optional)*<br>`flagIds` *(array, optional)*<br>`domainId` *(string/number, optional)* | Creates a new milestone objective. Accepts human note references (e.g. `1A1`) and flag names directly. |
| `update_objective` | `objectiveId` *(string/number)*<br>`title`, `description`, `appendDescription` *(optional)*<br>`done`, `toggleDone` *(optional)*<br>`deadline`, `priority`, `inPath` *(optional)*<br>`flagIds`, `linkNoteIds`, `unlinkNoteIds` *(optional)*<br>`domainId` *(optional)* | Modifies an existing objective. Allows marking done, updating progress, and linking/unlinking canvas notes. |
| `delete_objective` | `objectiveId` *(string/number)*<br>`domainId` *(string/number, optional)* | Deletes an objective from the workspace and unlinks it from referenced notes. |

---

### 5. Reusable Flags & Color Harmony (Live Bridge)

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `list_flags` | `domainId` *(string/number, optional)* | Lists all existing flags in the active or specified domain along with their hexadecimal colors and IDs. |
| `create_flag` | `label` *(string, 1-20 chars)*<br>`color` *(hex string, optional)*<br>`domainId` *(string/number, optional)* | Creates a reusable flag (max 20 characters). If color is omitted, automatically computes a distinct, harmonious shade using the golden angle algorithm. |
| `update_flag` | `flagId` *(string)*<br>`label` *(string, 1-20 chars, optional)*<br>`color` *(hex string, optional)*<br>`domainId` *(string/number, optional)* | Updates the label and/or color of an existing flag in-place without altering its ID or disconnecting referenced objectives. |
| `delete_flag` | `flagId` *(string)*<br>`domainId` *(string/number, optional)* | Permanently deletes a flag by its unique ID or by its exact label/name, unassigning it from all objectives. |

---

## Available MCP Resources (4 Resources)

In addition to tools, `noust-mcp` implements the standard Model Context Protocol Resources specification (`resources/list` and `resources/read`). Compatible MCP clients (Claude Desktop, Cursor, Antigravity, etc.) can inspect workspace metadata, attach notes or documents as context, or monitor active objectives without executing tool calls:

| Resource URI | Type | MIME Type | Description |
| :--- | :--- | :--- | :--- |
| `noust://workspace/active` | Static | `application/json` | Overview of the active workspace: workspace ID, workspace name, domains, note counts, document counts, and live bridge connection state. |
| `noust://notes/{noteId}` | Dynamic Template | `text/markdown` | Direct readable markdown content of a canvas note by ID or human reference (e.g. `1A1`). Formatted with title header, domain, canvas reference, and note body. Automatically discovered via `resources/list`. |
| `noust://documents/{docId}` | Dynamic Template | `text/markdown` | Direct readable markdown content of a Nexus document by ID. Formatted with title and markdown body. Automatically discovered via `resources/list`. |
| `noust://objectives/active` | Static | `application/json` | Real-time list of all active objectives, goals, milestones, categories, and attached color-coded flags. |

### Resource Auto-Discovery & Dual-Mode
- **Client Auto-Complete**: Clients that support resource listing automatically populate available notes and documents in their context selector or autocomplete (e.g., `@` context references in IDEs).
- **Dual-Mode Continuity**: When Noust is open in your browser with bridge enabled, resources dynamically query live in-memory state. When Noust is closed, resources load directly from the local `.noust` file on disk.

---

## Security & Architecture

`noust-mcp` is designed with strict local-first security principles:

1. **Zero External Data Transmission**: All server operations occur strictly on your local machine (`127.0.0.1`). No notes, tokens, or workspace data are sent to any remote servers.
2. **Path Confinement**: The server strictly verifies canonical paths (`realpath`) and refuses to read or write any files outside the designated workspace folder or without the `.noust` extension.
3. **CSWSH & Rebinding Immunity**: The local WebSocket bridge validates `Host` and `Origin` headers against a strict whitelist (rejecting arbitrary subdomains and opaque origins).
4. **Zero-Trust Token Pairing**: Each session generates an ephemeral 256-bit token (`.noust-bridge.token`) restricted to OS file permissions `0600`. Only the Noust browser tab holding permission to that local directory can authenticate.
5. **Full History & Undo Support**: Live actions (notes, documents, objectives, and flags) integrate directly with Noust's undo engine (`Ctrl+Z`), ensuring user control over AI actions.

---

## License

[MIT](LICENSE) © [Lucas Vazzoller Marangoni (Noust.app)](https://noust.app)
