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
// tslint:disable:no-submodule-imports
const fs = require("fs");
const glob = require("glob");
const Path = require("path");
const request = require("request-promise-native");
const Parser = require("tree-sitter");
const bash = require("tree-sitter-bash");
const URI = require("urijs");
const LSP = require("vscode-languageserver");
const array_1 = require("./util/array");
const flatten_1 = require("./util/flatten");
const TreeSitterUtil = require("./util/tree-sitter");
/**
 * The Analyzer uses the Abstract Syntax Trees (ASTs) that are provided by
 * tree-sitter to find definitions, reference, etc.
 */
class Analyzer {
    constructor() {
        this.uriToTextDocument = {};
        this.uriToTreeSitterTrees = {};
        // We need this to find the word at a given point etc.
        this.uriToFileContent = {};
        this.uriToDeclarations = {};
        this.treeSitterTypeToLSPKind = {
            // These keys are using underscores as that's the naming convention in tree-sitter.
            environment_variable_assignment: LSP.SymbolKind.Variable,
            function_definition: LSP.SymbolKind.Function,
            variable_assignment: LSP.SymbolKind.Variable,
        };
    }
    /**
     * Initialize the Analyzer based on a connection to the client and an optional
     * root path.
     *
     * If the rootPath is provided it will initialize all *.sh files it can find
     * anywhere on that path.
     */
    static fromRoot(connection, rootPath) {
        // This happens if the users opens a single bash script without having the
        // 'window' associated with a specific project.
        if (!rootPath) {
            return Promise.resolve(new Analyzer());
        }
        return new Promise((resolve, reject) => {
            glob('**/*.sh', { cwd: rootPath }, (err, paths) => {
                if (err != null) {
                    reject(err);
                }
                else {
                    const analyzer = new Analyzer();
                    paths.forEach(p => {
                        const absolute = Path.join(rootPath, p);
                        // only analyze files, glob pattern may match directories
                        if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) {
                            const uri = 'file://' + absolute;
                            connection.console.log('Analyzing ' + uri);
                            analyzer.analyze(uri, LSP.TextDocument.create(uri, 'shell', 1, fs.readFileSync(absolute, 'utf8')));
                        }
                    });
                    resolve(analyzer);
                }
            });
        });
    }
    /**
     * Find all the locations where something named name has been defined.
     */
    findDefinition(name) {
        const symbols = [];
        Object.keys(this.uriToDeclarations).forEach(uri => {
            const declarationNames = this.uriToDeclarations[uri][name] || [];
            declarationNames.forEach(d => symbols.push(d));
        });
        return symbols.map(s => s.location);
    }
    getExplainshellDocumentation({ pos, endpoint, }) {
        return __awaiter(this, void 0, void 0, function* () {
            const leafNode = this.uriToTreeSitterTrees[pos.textDocument.uri].rootNode.descendantForPosition({
                row: pos.position.line,
                column: pos.position.character,
            });
            // explainshell needs the whole command, not just the "word" (tree-sitter
            // parlance) that the user hovered over. A relatively successful heuristic
            // is to simply go up one level in the AST. If you go up too far, you'll
            // start to include newlines, and explainshell completely balks when it
            // encounters newlines.
            const interestingNode = leafNode.type === 'word' ? leafNode.parent : leafNode;
            const cmd = this.uriToFileContent[pos.textDocument.uri].slice(interestingNode.startIndex, interestingNode.endIndex);
            const explainshellResponse = yield request({
                uri: URI(endpoint)
                    .path('/api/explain')
                    .addQuery('cmd', cmd)
                    .toString(),
                json: true,
            });
            // Attaches debugging information to the return value (useful for logging to
            // VS Code output).
            const response = Object.assign({}, explainshellResponse, { cmd, cmdType: interestingNode.type });
            if (explainshellResponse.status === 'error') {
                return response;
            }
            else if (!explainshellResponse.matches) {
                return Object.assign({}, response, { status: 'error' });
            }
            else {
                const offsetOfMousePointerInCommand = this.uriToTextDocument[pos.textDocument.uri].offsetAt(pos.position) -
                    interestingNode.startIndex;
                const match = explainshellResponse.matches.find(helpItem => helpItem.start <= offsetOfMousePointerInCommand &&
                    offsetOfMousePointerInCommand < helpItem.end);
                const helpHTML = match && match.helpHTML;
                if (!helpHTML) {
                    return Object.assign({}, response, { status: 'error' });
                }
                return Object.assign({}, response, { helpHTML });
            }
        });
    }
    /**
     * Find all the locations where something named name has been defined.
     */
    findReferences(name) {
        const uris = Object.keys(this.uriToTreeSitterTrees);
        return flatten_1.flattenArray(uris.map(uri => this.findOccurrences(uri, name)));
    }
    /**
     * Find all occurrences of name in the given file.
     * It's currently not scope-aware.
     */
    findOccurrences(uri, query) {
        const tree = this.uriToTreeSitterTrees[uri];
        const contents = this.uriToFileContent[uri];
        const locations = [];
        TreeSitterUtil.forEach(tree.rootNode, n => {
            let name = null;
            let rng = null;
            if (TreeSitterUtil.isReference(n)) {
                const node = n.firstNamedChild || n;
                name = contents.slice(node.startIndex, node.endIndex);
                rng = TreeSitterUtil.range(node);
            }
            else if (TreeSitterUtil.isDefinition(n)) {
                const namedNode = n.firstNamedChild;
                name = contents.slice(namedNode.startIndex, namedNode.endIndex);
                rng = TreeSitterUtil.range(n.firstNamedChild);
            }
            if (name === query) {
                locations.push(LSP.Location.create(uri, rng));
            }
        });
        return locations;
    }
    /**
     * Find all symbol definitions in the given file.
     */
    findSymbols(uri) {
        const declarationsInFile = this.uriToDeclarations[uri] || {};
        return flatten_1.flattenObjectValues(declarationsInFile);
    }
    /**
     * Find unique symbol completions for the given file.
     */
    findSymbolCompletions(uri) {
        const hashFunction = ({ name, kind }) => `${name}${kind}`;
        return array_1.uniqueBasedOnHash(this.findSymbols(uri), hashFunction).map((symbol) => ({
            label: symbol.name,
            kind: this.symbolKindToCompletionKind(symbol.kind),
            data: {
                name: symbol.name,
                type: 'function',
            },
        }));
    }
    /**
     * Analyze the given document, cache the tree-sitter AST, and iterate over the
     * tree to find declarations.
     *
     * Returns all, if any, syntax errors that occurred while parsing the file.
     *
     */
    analyze(uri, document) {
        const contents = document.getText();
        const parser = new Parser();
        parser.setLanguage(bash);
        const tree = parser.parse(contents);
        this.uriToTextDocument[uri] = document;
        this.uriToTreeSitterTrees[uri] = tree;
        this.uriToDeclarations[uri] = {};
        this.uriToFileContent[uri] = contents;
        const problems = [];
        TreeSitterUtil.forEach(tree.rootNode, (n) => {
            if (n.type === 'ERROR') {
                problems.push(LSP.Diagnostic.create(TreeSitterUtil.range(n), 'Failed to parse expression', LSP.DiagnosticSeverity.Error));
                return;
            }
            else if (TreeSitterUtil.isDefinition(n)) {
                const named = n.firstNamedChild;
                const name = contents.slice(named.startIndex, named.endIndex);
                const namedDeclarations = this.uriToDeclarations[uri][name] || [];
                const parent = TreeSitterUtil.findParent(n, p => p.type === 'function_definition');
                const parentName = parent
                    ? contents.slice(parent.firstNamedChild.startIndex, parent.firstNamedChild.endIndex)
                    : null;
                namedDeclarations.push(LSP.SymbolInformation.create(name, this.treeSitterTypeToLSPKind[n.type], TreeSitterUtil.range(n), uri, parentName));
                this.uriToDeclarations[uri][name] = namedDeclarations;
            }
        });
        function findMissingNodes(node) {
            if (node.isMissing()) {
                problems.push(LSP.Diagnostic.create(TreeSitterUtil.range(node), `Syntax error: expected "${node.type}" somewhere in the file`, LSP.DiagnosticSeverity.Warning));
            }
            else if (node.hasError()) {
                node.children.forEach(findMissingNodes);
            }
        }
        findMissingNodes(tree.rootNode);
        return problems;
    }
    /**
     * Find the full word at the given point.
     */
    wordAtPoint(uri, line, column) {
        const document = this.uriToTreeSitterTrees[uri];
        const contents = this.uriToFileContent[uri];
        if (!document.rootNode) {
            // Check for lacking rootNode (due to failed parse?)
            return null;
        }
        const point = { row: line, column };
        const node = this.namedLeafDescendantForPosition(point, document.rootNode);
        if (!node) {
            return null;
        }
        const start = node.startIndex;
        const end = node.endIndex;
        let name = contents.slice(start, end);
        // Hack. Might be a problem with the grammar.
        if (name.endsWith('=')) {
            name = name.slice(0, name.length - 1);
        }
        return name;
    }
    /**
     * Given a tree and a point, try to find the named leaf node that the point corresponds to.
     * This is a helper for wordAtPoint, useful in cases where the point occurs at the boundary of
     * a word so the normal behavior of "namedDescendantForPosition" does not find the desired leaf.
     * For example, if you do
     * > (new Parser()).setLanguage(bash).parse("echo 42").rootNode.descendantForIndex(4).text
     * then you get 'echo 42', not the leaf node for 'echo'.
     */
    namedLeafDescendantForPosition(point, rootNode) {
        const node = rootNode.namedDescendantForPosition(point);
        if (node.childCount === 0) {
            return node;
        }
        else {
            // The node wasn't a leaf. Try to figure out what word we should use.
            const nodeToUse = this.searchForLeafNode(point, node);
            if (nodeToUse) {
                return nodeToUse;
            }
            else {
                return null;
            }
        }
    }
    /**
     * Recursive helper for namedLeafDescendantForPosition.
     */
    searchForLeafNode(point, parent) {
        let child = parent.firstNamedChild;
        while (child) {
            if (this.pointsEqual(child.startPosition, point) ||
                this.pointsEqual(child.endPosition, point)) {
                if (child.childCount === 0) {
                    return child;
                }
                else {
                    return this.searchForLeafNode(point, child);
                }
            }
            child = child.nextNamedSibling;
        }
        return null;
    }
    pointsEqual(point1, point2) {
        return point1.row === point2.row && point1.column === point2.column;
    }
    symbolKindToCompletionKind(s) {
        switch (s) {
            case LSP.SymbolKind.File:
                return LSP.CompletionItemKind.File;
            case LSP.SymbolKind.Module:
            case LSP.SymbolKind.Namespace:
            case LSP.SymbolKind.Package:
                return LSP.CompletionItemKind.Module;
            case LSP.SymbolKind.Class:
                return LSP.CompletionItemKind.Class;
            case LSP.SymbolKind.Method:
                return LSP.CompletionItemKind.Method;
            case LSP.SymbolKind.Property:
                return LSP.CompletionItemKind.Property;
            case LSP.SymbolKind.Field:
                return LSP.CompletionItemKind.Field;
            case LSP.SymbolKind.Constructor:
                return LSP.CompletionItemKind.Constructor;
            case LSP.SymbolKind.Enum:
                return LSP.CompletionItemKind.Enum;
            case LSP.SymbolKind.Interface:
                return LSP.CompletionItemKind.Interface;
            case LSP.SymbolKind.Function:
                return LSP.CompletionItemKind.Function;
            case LSP.SymbolKind.Variable:
                return LSP.CompletionItemKind.Variable;
            case LSP.SymbolKind.Constant:
                return LSP.CompletionItemKind.Constant;
            case LSP.SymbolKind.String:
            case LSP.SymbolKind.Number:
            case LSP.SymbolKind.Boolean:
            case LSP.SymbolKind.Array:
            case LSP.SymbolKind.Key:
            case LSP.SymbolKind.Null:
                return LSP.CompletionItemKind.Text;
            case LSP.SymbolKind.Object:
                return LSP.CompletionItemKind.Module;
            case LSP.SymbolKind.EnumMember:
                return LSP.CompletionItemKind.EnumMember;
            case LSP.SymbolKind.Struct:
                return LSP.CompletionItemKind.Struct;
            case LSP.SymbolKind.Event:
                return LSP.CompletionItemKind.Event;
            case LSP.SymbolKind.Operator:
                return LSP.CompletionItemKind.Operator;
            case LSP.SymbolKind.TypeParameter:
                return LSP.CompletionItemKind.TypeParameter;
            default:
                return LSP.CompletionItemKind.Text;
        }
    }
}
exports.default = Analyzer;
//# sourceMappingURL=analyser.js.map