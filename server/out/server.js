"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const LSP = require("vscode-languageserver");
const TurndownService = require("turndown");
const analyser_1 = require("./analyser");
const Builtins = require("./builtins");
const config = require("./config");
const executables_1 = require("./executables");
/**
 * The BashServer glues together the separate components to implement
 * the various parts of the Language Server Protocol.
 */
class BashServer {
    constructor(connection, executables, analyzer) {
        this.documents = new LSP.TextDocuments();
        this.connection = connection;
        this.executables = executables;
        this.analyzer = analyzer;
    }
    /**
     * Initialize the server based on a connection to the client and the protocols
     * initialization parameters.
     */
    static initialize(connection, params) {
        return Promise.all([
            executables_1.default.fromPath(process.env.PATH),
            analyser_1.default.fromRoot(connection, params.rootPath),
        ]).then(xs => {
            const executables = xs[0];
            const analyzer = xs[1];
            return new BashServer(connection, executables, analyzer);
        });
    }
    /**
     * Register handlers for the events from the Language Server Protocol that we
     * care about.
     */
    register(connection) {
        // The content of a text document has changed. This event is emitted
        // when the text document first opened or when its content has changed.
        this.documents.listen(this.connection);
        this.documents.onDidChangeContent(change => {
            const uri = change.document.uri;
            const diagnostics = this.analyzer.analyze(uri, change.document);
            if (config.getHighlightParsingError()) {
                connection.sendDiagnostics({
                    uri: change.document.uri,
                    diagnostics,
                });
            }
        });
        // Register all the handlers for the LSP events.
        connection.onHover(this.onHover.bind(this));
        connection.onDefinition(this.onDefinition.bind(this));
        connection.onDocumentSymbol(this.onDocumentSymbol.bind(this));
        connection.onDocumentHighlight(this.onDocumentHighlight.bind(this));
        connection.onReferences(this.onReferences.bind(this));
        connection.onCompletion(this.onCompletion.bind(this));
        connection.onCompletionResolve(this.onCompletionResolve.bind(this));
    }
    /**
     * The parts of the Language Server Protocol that we are currently supporting.
     */
    capabilities() {
        return {
            // For now we're using full-sync even though tree-sitter has great support
            // for partial updates.
            textDocumentSync: this.documents.syncKind,
            completionProvider: {
                resolveProvider: true,
            },
            hoverProvider: true,
            documentHighlightProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            referencesProvider: true,
        };
    }
    getWordAtPoint(params) {
        return this.analyzer.wordAtPoint(params.textDocument.uri, params.position.line, params.position.character);
    }
    onHover(pos) {
        return __awaiter(this, void 0, void 0, function* () {
            this.connection.console.log(`Hovering over ${pos.position.line}:${pos.position.character}`);
            const word = this.getWordAtPoint(pos);
            const explainshellEndpoint = config.getExplainshellEndpoint();
            if (explainshellEndpoint) {
                this.connection.console.log(`Query ${explainshellEndpoint}`);
                const response = yield this.analyzer.getExplainshellDocumentation({
                    pos,
                    endpoint: explainshellEndpoint,
                });
                if (response.status === 'error') {
                    this.connection.console.log('getExplainshellDocumentation returned: ' + JSON.stringify(response, null, 4));
                }
                else {
                    return {
                        contents: {
                            kind: 'markdown',
                            value: new TurndownService().turndown(response.helpHTML),
                        },
                    };
                }
            }
            if (Builtins.isBuiltin(word)) {
                return Builtins.documentation(word).then(doc => ({
                    contents: {
                        language: 'plaintext',
                        value: doc,
                    },
                }));
            }
            if (this.executables.isExecutableOnPATH(word)) {
                return this.executables.documentation(word).then(doc => ({
                    contents: {
                        language: 'plaintext',
                        value: doc,
                    },
                }));
            }
            return null;
        });
    }
    onDefinition(pos) {
        this.connection.console.log(`Asked for definition at ${pos.position.line}:${pos.position.character}`);
        const word = this.getWordAtPoint(pos);
        return this.analyzer.findDefinition(word);
    }
    onDocumentSymbol(params) {
        return this.analyzer.findSymbols(params.textDocument.uri);
    }
    onDocumentHighlight(pos) {
        const word = this.getWordAtPoint(pos);
        return this.analyzer
            .findOccurrences(pos.textDocument.uri, word)
            .map(n => ({ range: n.range }));
    }
    onReferences(params) {
        const word = this.getWordAtPoint(params);
        return this.analyzer.findReferences(word);
    }
    onCompletion(pos) {
        this.connection.console.log(`Asked for completions at ${pos.position.line}:${pos.position.character}`);
        const symbolCompletions = this.analyzer.findSymbolCompletions(pos.textDocument.uri);
        const programCompletions = this.executables.list().map((s) => {
            return {
                label: s,
                kind: LSP.SymbolKind.Function,
                data: {
                    name: s,
                    type: 'executable',
                },
            };
        });
        const builtinsCompletions = Builtins.LIST.map(builtin => ({
            label: builtin,
            kind: LSP.SymbolKind.Method,
            data: {
                name: builtin,
                type: 'builtin',
            },
        }));
        const allCompletions = [
            ...symbolCompletions,
            ...programCompletions,
            ...builtinsCompletions,
        ];
        // Filter to only return suffixes of the current word
        const currentWord = this.getWordAtPoint(pos);
        if (currentWord) {
            return allCompletions.filter((x) => x.label && x.label.startsWith(currentWord));
        }
        else {
            // If we couldn't determine the word for some reason (like being at the beginning of a line)
            // then return all completions
            return allCompletions;
        }
    }
    onCompletionResolve(item) {
        return __awaiter(this, void 0, void 0, function* () {
            const { data: { name, type } } = item;
            try {
                if (type === 'executable') {
                    const doc = yield this.executables.documentation(name);
                    return Object.assign({}, item, { detail: doc });
                }
                else if (type === 'builtin') {
                    const doc = yield Builtins.documentation(name);
                    return Object.assign({}, item, { detail: doc });
                }
                else {
                    return item;
                }
            }
            catch (error) {
                return item;
            }
        });
    }
}
exports.default = BashServer;
//# sourceMappingURL=server.js.map