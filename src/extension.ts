import * as vscode from 'vscode';
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:42069';
const SEND_DEBOUNCE_MS = 75;
const SEND_MAX_WAIT_MS = 250;

type ChangeCommand = { index: number; add: string } | { index: number; del: number };

const snapshots = new Map<string, string>();
let applyingRemote = 0;

function isTrackable(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(doc.uri) !== undefined;
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

    const bridge = createBridge(output, async (message) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isTrackable(editor.document)) {
            return;
        }

        const commands = JSON.parse(message as string);

        applyingRemote += 1;
        try {
            await editor.edit((editBuilder) => {
                output.appendLine(`[ws] applying ${JSON.stringify(commands)}`);
                for (const command of commands) {
                    output.appendLine(`[ws] applying command: ${JSON.stringify(command)}`);
                    if ('add' in command) {
                        editBuilder.insert(editor.document.positionAt(command.index), command.add);
                    } else {
                        editBuilder.delete(
                            new vscode.Range(
                                editor.document.positionAt(command.index),
                                editor.document.positionAt(command.index + command.del)
                            )
                        );
                    }
                }
            });
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
        output.appendLine(`[change] changes: ${JSON.stringify(event.contentChanges)}`);
        const changes = [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
        const commands: ChangeCommand[] = [];

        for (const change of changes) {
            const index = change.rangeOffset;
            if (change.rangeLength > 0) {
                const deleted = before.slice(index, index + change.rangeLength);
                if (deleted.length > 0) {
                    commands.push({ index, del: deleted.length });
                }
            }
            if (change.text.length > 0) {
                commands.push({ index, add: change.text });
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

    context.subscriptions.push(onOpen, onClose, onChange);
    context.subscriptions.push({
        dispose: () => {
            for (const uri of Array.from(pendingCommandsByUri.keys())) {
                flushBuffered(uri);
            }
        }
    });
}

export function deactivate() {}
