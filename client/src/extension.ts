import * as path from "path";
import {
  workspace as Workspace,
  window as Window,
  ExtensionContext,
  TextDocument,
  OutputChannel,
  WorkspaceFolder,
  Uri,
  WorkspaceConfiguration,
} from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  TransportKind,
} from "vscode-languageclient";

const SUPPORTED_EXTENSIONS = ["css", "scss", "less"];
const SUPPORTED_EXTENSION_REGEX = /\.(css|scss|less)$/;

let defaultClient: LanguageClient;
const clients: Map<string, LanguageClient> = new Map();

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
  if (_sortedWorkspaceFolders === void 0) {
    _sortedWorkspaceFolders = Workspace.workspaceFolders
      ? Workspace.workspaceFolders
          .map((folder) => {
            let result = folder.uri.toString();
            if (result.charAt(result.length - 1) !== "/") {
              result = result + "/";
            }
            return result;
          })
          .sort((a, b) => {
            return a.length - b.length;
          })
      : [];
  }
  return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(
  () => (_sortedWorkspaceFolders = undefined)
);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
  const sorted = sortedWorkspaceFolders();
  for (const element of sorted) {
    let uri = folder.uri.toString();
    if (uri.charAt(uri.length - 1) !== "/") {
      uri = uri + "/";
    }
    if (uri.startsWith(element)) {
      return Workspace.getWorkspaceFolder(Uri.parse(element))!;
    }
  }
  return folder;
}

export function activate(context: ExtensionContext): void {
  const module = context.asAbsolutePath(
    path.join("server", "out", "server.js")
  );
  const outputChannel: OutputChannel = Window.createOutputChannel("CSS Peek");

  const config: WorkspaceConfiguration = Workspace.getConfiguration("cssPeek");
  const peekFromLanguages: Array<string> = config.get(
    "peekFromLanguages"
  ) as Array<string>;
  const peekToInclude = SUPPORTED_EXTENSIONS.map((l) => `**/*.${l}`);
  const peekToExclude: Array<string> = config.get("peekToExclude") as Array<
    string
  >;

  function didOpenTextDocument(document: TextDocument): void {
    // TODO: Return if unsupported document.languageId
    if (
      !["file", "untitled"].includes(document.uri.scheme) ||
      (!peekFromLanguages.includes(document.languageId) &&
        !SUPPORTED_EXTENSION_REGEX.test(document.fileName))
    ) {
      return;
    }

    const documentSelector = [
      ...SUPPORTED_EXTENSIONS.map((language) => ({
        scheme: "file",
        language,
      })),
      ...SUPPORTED_EXTENSIONS.map((language) => ({
        scheme: "untitled",
        language,
      })),
      ...peekFromLanguages.map((language) => ({
        scheme: "file",
        language,
      })),
      ...peekFromLanguages.map((language) => ({
        scheme: "untitled",
        language,
      })),
    ];

    const uri = document.uri;
    // Untitled files go to a default client.
    if (uri.scheme === "untitled" && !defaultClient) {
      const debugOptions = { execArgv: ["--nolazy", "--inspect=6010"] };
      const serverOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: debugOptions },
      };
      const clientOptions: LanguageClientOptions = {
        documentSelector,
        synchronize: {
          configurationSection: "cssPeek",
        },
        initializationOptions: {
          stylesheets: [],
          peekFromLanguages,
        },
        diagnosticCollectionName: "css-peek",
        outputChannel,
      };
      defaultClient = new LanguageClient(
        "css-peek",
        "CSS Peek",
        serverOptions,
        clientOptions
      );
      defaultClient.registerProposedFeatures();
      defaultClient.start();
      return;
    }
    let folder = Workspace.getWorkspaceFolder(uri);
    // Files outside a folder can't be handled. This might depend on the language.
    // Single file languages like JSON might handle files outside the workspace folders.
    if (!folder) {
      return;
    }
    // If we have nested workspace folders we only start a server on the outer most workspace folder.
    folder = getOuterMostWorkspaceFolder(folder);

    if (!clients.has(folder.uri.toString())) {
      Workspace.findFiles(
        `{${(peekToInclude || []).join(",")}}`,
        `{${(peekToExclude || []).join(",")}}`
      ).then((file_searches) => {
        const potentialFiles: Uri[] = file_searches.filter(
          (uri: Uri) => uri.scheme === "file"
        );

        const debugOptions = {
          execArgv: ["--nolazy", `--inspect=${6011 + clients.size}`],
        };
        const serverOptions = {
          run: { module, transport: TransportKind.ipc },
          debug: {
            module,
            transport: TransportKind.ipc,
            options: debugOptions,
          },
        };
        const clientOptions: LanguageClientOptions = {
          documentSelector,
          diagnosticCollectionName: "css-peek",
          synchronize: {
            configurationSection: "cssPeek",
          },
          initializationOptions: {
            stylesheets: potentialFiles.map((u) => ({
              uri: u.toString(),
              fsPath: u.fsPath,
            })),
            peekFromLanguages,
          },
          workspaceFolder: folder,
          outputChannel,
        };
        const client = new LanguageClient(
          "css-peek",
          "CSS Peek",
          serverOptions,
          clientOptions
        );
        client.registerProposedFeatures();
        client.start();
        clients.set(folder.uri.toString(), client);
      });
    }
  }

  Workspace.onDidOpenTextDocument(didOpenTextDocument);
  Workspace.textDocuments.forEach(didOpenTextDocument);
  Workspace.onDidChangeWorkspaceFolders((event) => {
    for (const folder of event.removed) {
      const client = clients.get(folder.uri.toString());
      if (client) {
        clients.delete(folder.uri.toString());
        client.stop();
      }
    }
  });
}

export function deactivate(): Thenable<void> {
  const promises: Thenable<void>[] = [];
  if (defaultClient) {
    promises.push(defaultClient.stop());
  }
  for (const client of clients.values()) {
    promises.push(client.stop());
  }
  return Promise.all(promises).then(() => undefined);
}
