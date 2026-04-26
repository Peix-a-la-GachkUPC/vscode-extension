
import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as path from 'path';

const WS_URL = 'ws://127.0.0.1:42069';
const SEND_DEBOUNCE_MS = 5;
const SEND_MAX_WAIT_MS = 10;

type TextPos = { line: number; column: number };
type AddCommand = { pos: TextPos; add: string };
type DelCommand = { pos: TextPos; del: number; deleted_text?: string };
type FileScoped = { file?: string };
type ChangeCommand = (AddCommand | DelCommand) & FileScoped;
type SyncFileEntry = { file: string; content: string };
type SyncAllPayload = { type: 'sync_all'; files: SyncFileEntry[] };
type IncomingPayload = ChangeCommand[] | SyncAllPayload;

const snapshots = new Map<string, string>();
let applyingRemote = 0;

type LegacyIndexAddCommand = { index: number; add: string } & FileScoped;
type LegacyIndexDelCommand = { index: number; del: number; deleted_text?: string } & FileScoped;
type LegacyIndexCommand = LegacyIndexAddCommand | LegacyIndexDelCommand;
type IncomingChangeCommand = ChangeCommand | LegacyIndexCommand;

function isTrackable(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(doc.uri) !== undefined;
}

function toVscodePosition(pos: TextPos): vscode.Position {
    return new vscode.Position(pos.line, pos.column);
}

function toWirePosition(pos: vscode.Position): TextPos {
    return { line: pos.line, column: pos.character };
}

function positionFromCommand(document: vscode.TextDocument, command: IncomingChangeCommand): vscode.Position {
    if ('pos' in command) {
        return toVscodePosition(command.pos);
    }
    return document.positionAt(command.index);
}

function endPositionForDelete(document: vscode.TextDocument, start: vscode.Position, command: IncomingChangeCommand): vscode.Position {
    if (!('del' in command)) {
        return start;
    }

    const deletedText = 'deleted_text' in command ? command.deleted_text : undefined;
    if (typeof deletedText === 'string') {
        const parts = deletedText.split('\n');
        if (parts.length === 1) {
            return start.translate(0, deletedText.length);
        }
        return new vscode.Position(start.line + (parts.length - 1), parts.at(-1)?.length ?? 0);
    }

    const del = command.del ?? 0;
    const endOffset = document.offsetAt(start) + del;
    return document.positionAt(endOffset);
}

function toScopedFilePath(doc: vscode.TextDocument): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) {
        return undefined;
    }

    const relativePath = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
    return `./${relativePath}`;
}

function uriFromScopedFilePath(scopedFilePath: string): vscode.Uri | undefined {
    const normalized = scopedFilePath.replace(/\\/g, '/');
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (normalized.startsWith('./')) {
        const relativePath = normalized.slice(2);
        if (!relativePath) {
            return undefined;
        }
        if (folders.length === 1 && folders[0].uri.scheme === 'file') {
            return vscode.Uri.file(path.join(folders[0].uri.fsPath, relativePath));
        }
        return undefined;
    }

    const slashIndex = normalized.indexOf('/');
    if (slashIndex > 0 && slashIndex < normalized.length - 1) {
        const folderName = normalized.slice(0, slashIndex);
        const relativePath = normalized.slice(slashIndex + 1);
        if (!relativePath) {
            return undefined;
        }

        const folder = folders.find((candidate) => candidate.name === folderName);
        if (folder && folder.uri.scheme === 'file') {
            return vscode.Uri.file(path.join(folder.uri.fsPath, relativePath));
        }
    }

    if (folders.length === 1 && folders[0].uri.scheme === 'file') {
        return vscode.Uri.file(path.join(folders[0].uri.fsPath, normalized));
    }

    return undefined;
}

type NewLine = {
    line: number;
    sign: -1 | 1;
    tstamp: number;
};
async function applyCommandsToDocument(document: vscode.TextDocument, commands: IncomingChangeCommand[], newLines: NewLine[]): Promise<void> {
    for (const command of commands) {
        const edit = new vscode.WorkspaceEdit();

        let pos = positionFromCommand(document, command);
        const lineDelta = newLines.reduce((acc, entry) => (entry.line < pos.line ? acc + entry.sign : acc), 0);
        if (lineDelta !== 0) {
            pos = pos.translate(lineDelta, 0);
        }

        if ('add' in command) {
            edit.insert(document.uri, pos, command.add);
        } else {
            const start = pos;
            edit.delete(
                document.uri,
                new vscode.Range(
                    start,
                    endPositionForDelete(document, start, command)
                )
            );
        }
        await vscode.workspace.applyEdit(edit);
    }
}

async function replaceDocumentText(document: vscode.TextDocument, content: string): Promise<void> {
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, content);
    await vscode.workspace.applyEdit(edit);
}

function parseIncomingPayload(message: unknown): IncomingPayload | undefined {
    if (typeof message === 'string') {
        try {
            const parsed = JSON.parse(message) as unknown;
            return parseIncomingPayload(parsed);
        } catch {
            return undefined;
        }
    }

    if (Array.isArray(message)) {
        return message as ChangeCommand[];
    }

    if (typeof message === 'object' && message !== null) {
        const candidate = message as Partial<SyncAllPayload>;
        if (candidate.type === 'sync_all' && Array.isArray(candidate.files)) {
            return { type: 'sync_all', files: candidate.files as SyncFileEntry[] };
        }
    }

    return undefined;
}

function createBridge(output: vscode.OutputChannel, onMessage: (message: unknown) => void) {
    let ws: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        ws = new WebSocket(WS_URL);

        ws.on('open', () => output.appendLine('[ws] connected'));
        ws.on('message', (data) => {
            const text = data.toString();
            output.appendLine(`[ws] received: ${JSON.stringify(JSON.parse(text))}`);
            if (!text.trim()) {
                return;
            }

            try {
                onMessage(JSON.parse(text) as unknown);
            } catch (e) {
                output.appendLine(`[ws] failed to parse message: ${e instanceof Error ? e.message : String(e)}`);
            }
        });

        ws.on('close', () => {
            output.appendLine('[ws] disconnected');
            reconnectTimer = setTimeout(connect, 1000);
        });

        ws.on('error', (error) => output.appendLine(`[ws] ${error.message}`));
    };

    connect();

    return {
        send: (payload: unknown) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                return;
            }
            ws.send(JSON.stringify(payload));
        },
        dispose: () => {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }
            if (ws) {
                ws.close();
            }
        }
    };
}
export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Universal Live Share');
    context.subscriptions.push(output);
    let acceptExternalEdits = context.workspaceState.get<boolean>('acceptExternalEdits', true);

    const remoteCursorDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 95, 86, 0.45)',
        borderRadius: '2px',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    context.subscriptions.push(remoteCursorDecorationType);
    const remoteCursorByUri = new Map<string, TextPos>();

    const externalToggleItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    externalToggleItem.command = 'universal-live-share.toggleExternalEdits';

    const syncAllItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    syncAllItem.command = 'universal-live-share.syncAllFiles';
    syncAllItem.text = '$(sync) Live Share: Sync all';
    syncAllItem.tooltip = 'Send all workspace files to peers';

    const refreshExternalToggleUi = () => {
        externalToggleItem.text = acceptExternalEdits
            ? '$(pass) External edits: ON'
            : '$(circle-slash) External edits: OFF';
        externalToggleItem.tooltip = acceptExternalEdits
            ? 'Disable external edits'
            : 'Enable external edits';
    };

    refreshExternalToggleUi();
    externalToggleItem.show();
    syncAllItem.show();
    context.subscriptions.push(externalToggleItem, syncAllItem);

    const renderRemoteCursor = (editor: vscode.TextEditor | undefined) => {
        if (!editor) {
            return;
        }

        const uri = editor.document.uri.toString();
        const cursorPos = remoteCursorByUri.get(uri);
        if (cursorPos === undefined) {
            editor.setDecorations(remoteCursorDecorationType, []);
            return;
        }

        const position = toVscodePosition(cursorPos);
        const line = editor.document.lineAt(position.line);
        const hasCharAtPosition = position.character < line.text.length;
        const range = hasCharAtPosition
            ? new vscode.Range(position, position.translate(0, 1))
            : position.character > 0
                ? new vscode.Range(position.translate(0, -1), position)
                : new vscode.Range(position, position);

        editor.setDecorations(remoteCursorDecorationType, [{ range }]);
    };

    const bridge = createBridge(output, async (message) => {
        const payload = parseIncomingPayload(message);
        if (!payload) {
            output.appendLine('[ws] ignored unsupported payload');
            return;
        }

        if (!acceptExternalEdits) {
            output.appendLine('[ws] external edits ignored (disabled)');
            return;
        }

        const commandsByFile = new Map<string, IncomingChangeCommand[]>();
        const legacyCommands: IncomingChangeCommand[] = [];

        if (Array.isArray(payload)) {
            for (const command of payload as unknown as IncomingChangeCommand[]) {
                const fileField = (command as { file?: unknown }).file;
                if (typeof fileField === 'string' && fileField.length > 0) {
                    const fileCommands = commandsByFile.get(fileField) ?? [];
                    fileCommands.push(command);
                    commandsByFile.set(fileField, fileCommands);
                } else {
                    legacyCommands.push(command);
                }
            }
        }

        applyingRemote += 1;
        try {
            output.appendLine(`[ws] applying ${JSON.stringify(payload)}`);

            if (!Array.isArray(payload)) {
                for (const entry of payload.files) {
                    if (!entry || typeof entry.file !== 'string' || typeof entry.content !== 'string') {
                        continue;
                    }
                    const uri = uriFromScopedFilePath(entry.file);
                    if (!uri) {
                        output.appendLine(`[ws] could not resolve file path: ${entry.file}`);
                        continue;
                    }

                    try {
                        let existed = true;
                        try {
                            await vscode.workspace.fs.stat(uri);
                        } catch {
                            existed = false;
                        }

                        const parentUri = vscode.Uri.file(path.dirname(uri.fsPath));
                        await vscode.workspace.fs.createDirectory(parentUri);
                        await vscode.workspace.fs.writeFile(uri, Buffer.from(entry.content, 'utf8'));
                        snapshots.set(uri.toString(), entry.content);
                        output.appendLine(`[sync] ${existed ? 'updated' : 'created'} ${entry.file}`);
                    } catch (error) {
                        output.appendLine(
                            `[ws] failed to sync ${entry.file}: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }
                return;
            }

            const lastCommand = payload.at(-1) as IncomingChangeCommand | undefined;
            for (const [scopedPath, fileCommands] of commandsByFile) {
                const uri = uriFromScopedFilePath(scopedPath);
                if (!uri) {
                    output.appendLine(`[ws] could not resolve file path: ${scopedPath}`);
                    continue;
                }

                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    await applyCommandsToDocument(document, fileCommands, newLinesByUri.get(uri.toString()) ?? []);
                } catch (error) {
                    output.appendLine(
                        `[ws] failed to apply changes to ${scopedPath}: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            if (legacyCommands.length > 0) {
                const editor = vscode.window.activeTextEditor;
                if (!editor || !isTrackable(editor.document)) {
                    output.appendLine('[ws] legacy payload ignored because no active trackable editor');
                    return;
                }
                await applyCommandsToDocument(editor.document, legacyCommands, newLinesByUri.get(editor.document.uri.toString()) ?? []);
            }

            if (lastCommand) {
                let targetUri: string | undefined;
                if (typeof lastCommand.file === 'string') {
                    const resolved = uriFromScopedFilePath(lastCommand.file);
                    targetUri = resolved?.toString();
                }

                if (!targetUri) {
                    const editor = vscode.window.activeTextEditor;
                    if (editor && isTrackable(editor.document)) {
                        targetUri = editor.document.uri.toString();
                    }
                }

                if (!targetUri) {
                    return;
                }

                let cursorPos: TextPos | undefined;
                if ('pos' in lastCommand) {
                    cursorPos = lastCommand.pos;
                } else if ('index' in lastCommand) {
                    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === targetUri);
                    const doc = editor?.document;
                    if (doc) {
                        cursorPos = toWirePosition(doc.positionAt(lastCommand.index));
                    }
                }
                if (cursorPos) {
                    remoteCursorByUri.set(targetUri, cursorPos);
                }
                for (const visibleEditor of vscode.window.visibleTextEditors) {
                    if (visibleEditor.document.uri.toString() === targetUri) {
                        renderRemoteCursor(visibleEditor);
                    }
                }
            }
        } finally {
            applyingRemote -= 1;
        }
    });

    context.subscriptions.push({ dispose: () => bridge.dispose() });

    const pendingCommandsByUri = new Map<string, ChangeCommand[]>();
    const flushTimersByUri = new Map<string, ReturnType<typeof setTimeout>>();
    const firstBufferedAtByUri = new Map<string, number>();

    const flushBuffered = (uri: string) => {
        const timer = flushTimersByUri.get(uri);
        if (timer) {
            clearTimeout(timer);
            flushTimersByUri.delete(uri);
        }

        const buffered = pendingCommandsByUri.get(uri);
        if (!buffered || buffered.length === 0) {
            pendingCommandsByUri.delete(uri);
            firstBufferedAtByUri.delete(uri);
            return;
        }

        output.appendLine(`[flush] commands: ${JSON.stringify(buffered)}`);
        bridge.send(buffered);
        pendingCommandsByUri.delete(uri);
        firstBufferedAtByUri.delete(uri);
    };

    const scheduleFlush = (uri: string) => {
        const existingTimer = flushTimersByUri.get(uri);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const now = Date.now();
        const firstBufferedAt = firstBufferedAtByUri.get(uri) ?? now;
        firstBufferedAtByUri.set(uri, firstBufferedAt);

        const elapsed = now - firstBufferedAt;
        const remainingMaxWait = Math.max(0, SEND_MAX_WAIT_MS - elapsed);
        const delay = Math.min(SEND_DEBOUNCE_MS, remainingMaxWait);

        const timer = setTimeout(() => {
            flushBuffered(uri);
        }, delay);

        flushTimersByUri.set(uri, timer);
    };

    const syncAllFiles = async () => {
        for (const uri of Array.from(pendingCommandsByUri.keys())) {
            flushBuffered(uri);
        }

        const files = await vscode.workspace.findFiles(
            '**/*',
            '**/{.git,node_modules,dist,out,build,.next,.cache,coverage}/**'
        );

        const syncEntries: SyncFileEntry[] = [];
        for (const uri of files) {
            if (uri.scheme !== 'file') {
                continue;
            }

            try {
                const document = await vscode.workspace.openTextDocument(uri);
                if (!isTrackable(document)) {
                    continue;
                }

                const file = toScopedFilePath(document);
                if (!file) {
                    continue;
                }

                syncEntries.push({
                    file,
                    content: document.getText()
                });
            } catch {
                continue;
            }
        }

        bridge.send({ type: 'sync_all', files: syncEntries });
        output.appendLine(`[sync] sent ${syncEntries.length} files`);
        void vscode.window.setStatusBarMessage(`Universal Live Share: synced ${syncEntries.length} files`, 3000);
    };

    const toggleExternalEditsCommand = vscode.commands.registerCommand(
        'universal-live-share.toggleExternalEdits',
        async () => {
            acceptExternalEdits = !acceptExternalEdits;
            refreshExternalToggleUi();
            await context.workspaceState.update('acceptExternalEdits', acceptExternalEdits);
            output.appendLine(`[ws] external edits ${acceptExternalEdits ? 'enabled' : 'disabled'}`);
        }
    );

    const syncAllFilesCommand = vscode.commands.registerCommand('universal-live-share.syncAllFiles', async () => {
        await syncAllFiles();
    });

    for (const doc of vscode.workspace.textDocuments) {
        if (!isTrackable(doc)) {
            continue;
        }
        snapshots.set(doc.uri.toString(), doc.getText());
    }

    const onOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
        if (!isTrackable(doc)) {
            return;
        }
        snapshots.set(doc.uri.toString(), doc.getText());
    });

    const onClose = vscode.workspace.onDidCloseTextDocument((doc) => {
        flushBuffered(doc.uri.toString());
        const uri = doc.uri.toString();
        snapshots.delete(uri);
        remoteCursorByUri.delete(uri);
        newLinesByUri.delete(uri);
    });

    const onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
        renderRemoteCursor(editor);
    });


    const newLinesByUri = new Map<string, NewLine[]>();
    const NEW_LINE_RETENTION_MS = 1000;
    const pruneNewLinesForUri = (uri: string) => {
        const now = Date.now();
        const cutoff = now - NEW_LINE_RETENTION_MS;
        const bucket = newLinesByUri.get(uri);
        if (!bucket || bucket.length === 0) {
            newLinesByUri.delete(uri);
            return;
        }
        const pruned = bucket.filter((entry) => entry.tstamp >= cutoff);
        if (pruned.length === 0) {
            newLinesByUri.delete(uri);
        } else {
            newLinesByUri.set(uri, pruned);
        }
    };

    const onChange = vscode.workspace.onDidChangeTextDocument((event) => {
        if (!isTrackable(event.document) || event.contentChanges.length === 0) {
            return;
        }

        const uri = event.document.uri.toString();
        if (applyingRemote > 0) {
            snapshots.set(uri, event.document.getText());
            pruneNewLinesForUri(uri);
            return;
        }

        const before = snapshots.get(uri) ?? '';
        // output.appendLine(`[change] changes: ${JSON.stringify(event.contentChanges)}`);
        const changes = [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
        const commands: ChangeCommand[] = [];
        const scopedFilePath = toScopedFilePath(event.document);
        if (!scopedFilePath) {
            return;
        }

        const pushNewLines = (startLine: number, sign: -1 | 1, count: number) => {
            if (count <= 0) {
                return;
            }
            const tstamp = Date.now();
            const bucket = newLinesByUri.get(uri) ?? [];
            for (let i = 0; i < count; i += 1) {
                bucket.push({ line: startLine + i, sign, tstamp });
            }
            newLinesByUri.set(uri, bucket);
        };

        for (const change of changes) {
            const index = change.rangeOffset;
            const pos = toWirePosition(change.range.start);
            if (change.rangeLength > 0) {
                const deleted = before.slice(index, index + change.rangeLength);
                if (deleted.length > 0) {
                    const deletedNewlines = (deleted.match(/\n/g) ?? []).length;
                    pushNewLines(pos.line, -1, deletedNewlines);
                    commands.push({ pos, del: deleted.length, deleted_text: deleted, file: scopedFilePath });
                }
            }
            if (change.text.length > 0) {
                const addedNewlines = (change.text.match(/\n/g) ?? []).length;
                pushNewLines(pos.line, 1, addedNewlines);
                commands.push({ pos, add: change.text, file: scopedFilePath });
            }
        }

        if (commands.length > 0) {
            const buffered = pendingCommandsByUri.get(uri) ?? [];
            buffered.push(...commands);
            pendingCommandsByUri.set(uri, buffered);
            scheduleFlush(uri);
        }

        snapshots.set(uri, event.document.getText());
    });

    context.subscriptions.push(onOpen, onClose, onChange, onActiveEditorChange, toggleExternalEditsCommand, syncAllFilesCommand);
    context.subscriptions.push({
        dispose: () => {
            for (const uri of Array.from(pendingCommandsByUri.keys())) {
                flushBuffered(uri);
            }
        }
    });
}

export function deactivate() {}
