'use strict'

import * as LSP from 'vscode-languageserver'

import Analyzer from './analyser'
import BashServer from './server'

// tslint:disable-next-line:no-var-requires
const pkg = require('../package')

export function listen() {
  // Create a connection for the server.
  // The connection uses stdin/stdout for communication.
  const connection: LSP.IConnection = LSP.createConnection(
    new LSP.StreamMessageReader(process.stdin),
    new LSP.StreamMessageWriter(process.stdout),
  )

  const analyzer = new Analyzer()
  const server = new BashServer(connection, analyzer)

  server.register(connection)

  connection.onInitialize((params: LSP.InitializeParams): Promise<LSP.InitializeResult> => {
    connection.console.log(`Initialized server v. ${pkg.version} for ${params.rootUri}`)

    // Begin analyzing the root directory, but don't hold up the response on it
    analyzer.analyzeRoot(connection, params.rootPath)

    return Promise.resolve({
      capabilities: server.capabilities(),
    })
  })

  connection.listen()
}
