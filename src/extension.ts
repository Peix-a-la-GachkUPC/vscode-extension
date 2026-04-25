import * as vscode from 'vscode';
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:42069';

type ChangeCommand = { index: number; add: string } | { index: number; del: number };

const snapshots = new Map<string, string>();

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
			if (!text.trim()) {
				return;
			}
			try {
				onMessage(JSON.parse(text) as unknown);
			} catch {
				output.appendLine(`[ws] invalid json: ${text}`);
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

	let applyingRemoteChange = false;

	const bridge = createBridge(output, async (message) => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !isTrackable(editor.document)) {
			return;
		}

		const commands = (Array.isArray(message) ? message : [message]) as ChangeCommand[];
		if (commands.length === 0) {
			return;
		}

		applyingRemoteChange = true;
		try {
			await editor.edit((editBuilder) => {
				for (const command of commands) {
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
			applyingRemoteChange = false;
		}
	});

	context.subscriptions.push({ dispose: () => bridge.dispose() });

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
		snapshots.delete(doc.uri.toString());
	});

	const onChange = vscode.workspace.onDidChangeTextDocument((event) => {
		if (applyingRemoteChange || !isTrackable(event.document) || event.contentChanges.length === 0) {
			return;
		}

		const uri = event.document.uri.toString();
		const before = snapshots.get(uri) ?? '';
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
			bridge.send(commands);
		}

		snapshots.set(uri, event.document.getText());
	});

	context.subscriptions.push(onOpen, onClose, onChange);
}

export function deactivate() {}
