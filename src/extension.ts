
import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as path from 'path';

const WS_URL = 'ws://127.0.0.1:42069';
const SEND_DEBOUNCE_MS = 500;
const SEND_MAX_WAIT_MS = 1000;

type AddCommand = { index: number; add: string };
type DelCommand = { index: number; del: number; deleted_text?: string };
type FileScoped = { file?: string };
type ChangeCommand = (AddCommand | DelCommand) & FileScoped;

const snapshots = new Map<string, string>();
let applyingRemote = 0;

function isTrackable(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(doc.uri) !== undefined;
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

    const slashIndex = scopedFilePath.indexOf('/');
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

async function applyCommandsToDocument(document: vscode.TextDocument, commands: ChangeCommand[]): Promise<void> {
    for (const command of commands) {
        const edit = new vscode.WorkspaceEdit();
        if ('add' in command) {
            edit.insert(document.uri, document.positionAt(command.index), command.add);
        } else {
            const del = command.del ?? command.deleted_text?.length ?? 0;
            edit.delete(
                document.uri,
                new vscode.Range(
                    document.positionAt(command.index),
                    document.positionAt(command.index + del)
                )
            );
        }
        await vscode.workspace.applyEdit(edit);
    }
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
                onMessage(JSON.parse(text).value as unknown);
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

    const remoteCursorDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 95, 86, 0.45)',
        borderRadius: '2px',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    context.subscriptions.push(remoteCursorDecorationType);
    const remoteCursorByUri = new Map<string, number>();

    const renderRemoteCursor = (editor: vscode.TextEditor | undefined) => {
        if (!editor) {
            return;
        }

        const uri = editor.document.uri.toString();
        const cursorIndex = remoteCursorByUri.get(uri);
        if (cursorIndex === undefined) {
            editor.setDecorations(remoteCursorDecorationType, []);
            return;
        }

        const position = editor.document.positionAt(cursorIndex);
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
		const editor = vscode.window.activeTextEditor;
		if (!editor || !isTrackable(editor.document)) {
			return;
		}
        const commands = JSON.parse(message as string) as ChangeCommand[];
        if (!Array.isArray(commands) || commands.length === 0) {
            return;
        }
        const lastCommand = commands.at(-1) as ChangeCommand | undefined;
        const commandsByFile = new Map<string, ChangeCommand[]>();
        const legacyCommands: ChangeCommand[] = [];
        for (const command of commands) {
            if (typeof command.file === 'string' && command.file.length > 0) {
                const fileCommands = commandsByFile.get(command.file) ?? [];
                fileCommands.push(command);
                commandsByFile.set(command.file, fileCommands);
            } else {
                legacyCommands.push(command);
            }
        }

        applyingRemote += 1;
        try {
            output.appendLine(`[ws] applying ${JSON.stringify(commands)}`);
            for (const [scopedPath, fileCommands] of commandsByFile) {
                const uri = uriFromScopedFilePath(scopedPath);
                if (!uri) {
                    output.appendLine(`[ws] could not resolve file path: ${scopedPath}`);
                    continue;
                }

                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    await applyCommandsToDocument(document, fileCommands);
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
                await applyCommandsToDocument(editor.document, legacyCommands);
            }

            if (lastCommand) {
                const uri = editor.document.uri.toString();
                remoteCursorByUri.set(uri, lastCommand.index);
                for (const visibleEditor of vscode.window.visibleTextEditors) {
                    if (visibleEditor.document.uri.toString() === uri) {
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
        snapshots.delete(doc.uri.toString());
        remoteCursorByUri.delete(doc.uri.toString());
    });

    const onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
        renderRemoteCursor(editor);
    });

    const onChange = vscode.workspace.onDidChangeTextDocument((event) => {
        if (!isTrackable(event.document) || event.contentChanges.length === 0) {
            return;
        }

        const uri = event.document.uri.toString();
        if (applyingRemote > 0) {
            snapshots.set(uri, event.document.getText());
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

        for (const change of changes) {
            const index = change.rangeOffset;
            if (change.rangeLength > 0) {
                const deleted = before.slice(index, index + change.rangeLength);
                if (deleted.length > 0) {
                    commands.push({ index, del: deleted.length, deleted_text: deleted, file: scopedFilePath });
                }
            }
            if (change.text.length > 0) {
                commands.push({ index, add: change.text, file: scopedFilePath });
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

    context.subscriptions.push(onOpen, onClose, onChange, onActiveEditorChange);
    context.subscriptions.push({
        dispose: () => {
            for (const uri of Array.from(pendingCommandsByUri.keys())) {
                flushBuffered(uri);
            }
        }
    });
}

export function deactivate() {}