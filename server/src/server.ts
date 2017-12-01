/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict'

import {
    IPCMessageReader, IPCMessageWriter,
    createConnection, IConnection, TextDocumentSyncKind,
    TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
    InitializeParams, InitializeResult, TextDocumentPositionParams,
    CompletionItem, CompletionItemKind, Hover, SignatureHelp,
    SignatureInformation, ParameterInformation, Command, CodeActionParams,
    NotificationType
} from 'vscode-languageserver'
import Ycm, {Settings} from './ycm'
import * as _ from 'lodash'
import {logger, loggerInit, crossPlatformUri} from './utils'

process.on('uncaughtException', err => {
    logger('!!!uncaughtException!!!', err)
})

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process))

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments()
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection)

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites.
let workspaceRoot: string
let workspaceConfiguration: Settings

connection.onInitialize((params): InitializeResult => {
    workspaceRoot = crossPlatformUri(params.rootUri)
    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: documents.syncKind,
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['.', ':', '<', '"', '=', '/', '>', '*', '&']
            },
            hoverProvider: true,
            definitionProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['(']
            },
            codeActionProvider: true
        }
    }
})

connection.onCodeAction(async (param) => {
    logger('onCodeAction', JSON.stringify(param))
    try {
        const ycm = await getYcm()
        const fixs = await ycm.fixIt(param.textDocument.uri, param.range.start, documents)
        return fixs.map(it => {
            return {
                title: `Fix: ${it.text}`,
                command: 'ycm.FixIt',
                arguments: [it]
            }
        }) as Command[]
    } catch (e) {
        logger('onCodeAction', e)
    }
    return []
})

connection.onNotification<YcmFixIt, string>(new NotificationType<YcmFixIt, string>('FixIt'), async (args) => {
    logger('On FixIt', JSON.stringify(args))
})


connection.onHover(async (event): Promise<Hover> => {
    const ycm = await getYcm()
    try {
        return await ycm.getType(event.textDocument.uri, event.position, documents, workspaceConfiguration.ycmd.use_imprecise_get_type)
    } catch (err) {
        logger(`onHover error`, err)
    }
})

connection.onDefinition(async (event) => {
    const ycm = await getYcm()
    try {
        return await ycm.goTo(event.textDocument.uri, event.position, documents)
    } catch (err) {
        logger(`onDefinition error`, err)
    }
})

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async (change) => {
    logger(`onDidChangeContent ${JSON.stringify(change.document.uri)}`)
    const ycm = await getYcm()
})

// The settings interface describe the server relevant settings part
async function getYcm(): Promise<Ycm> {
    if (!workspaceRoot || !workspaceConfiguration)
        return await new Promise<Ycm>((resolve, reject) => setTimeout(() => getYcm(), 100))
    try {
        return await Ycm.getInstance(workspaceRoot, workspaceConfiguration, connection.window)
    } catch (err) {
        logger('getYcm error', err)
        connection.window.showErrorMessage(`Ycm startup failed. Please check your ycmd or python path. Detail: ${err.message || err}`)
    }
}

async function getIssues(document: TextDocument) {
    const ycm = await getYcm()
    connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: await ycm.readyToParse(document.uri, documents)
    })
}

function countArgs(docString: String, startOffset: number, endOffset: number): number {
    const scopeChars = {['('] : ')',
                        ['['] : ']',
                        ['{'] : '}'}
    let argCount = 0
    for (let offset = startOffset; offset < endOffset; offset++) {
        if (docString[offset] === ',') {
            argCount++
            continue
        }

        // see if we have a [nested] scope and skip over its contents if we do
        const scopeOpenChar = docString[offset]
        const scopeEndChar = scopeChars[scopeOpenChar]
        if (scopeEndChar) {
            offset++
            for (let numToMatch = 1; offset < endOffset && numToMatch > 0; offset++) {
                let currChar = docString[offset]
                numToMatch += currChar === scopeOpenChar ? 1 : (currChar === scopeEndChar ? -1 : 0)
            }
            // back up since offset is going to be incremented as part of the 'for' loop
            offset--
        }
    }
    return argCount
}

connection.onSignatureHelp(async (textDocumentPosition: TextDocumentPositionParams): Promise<SignatureHelp> => {
    const ycm = await getYcm()
    const uri = textDocumentPosition.textDocument.uri
    const doc = documents.get(uri)
    let offset = doc.offsetAt(textDocumentPosition.position)
    const origString = doc.getText().slice(0, offset)

    // Replace all single-line strings' contents, so as to not confuse
    // our later feable parsing attemps by, e.g. a string with a comma in it.
    // This isn't perfect in many ways, but helps more than it hurts.
    function replacer(match, introCapture, contentsCapture, endCapture, offset, wholeString) {
        return introCapture + 'x'.repeat(contentsCapture.length) + endCapture
    }
    // regex adapted from http://www.regular-expressions.info/examplesprogrammer.html
    const docString = origString.replace(/(")([^"\\\r\n]*(?:\\.[^"\\\r\n]*)*)("|$)/g, replacer)
    // and single-quote character literals
                                .replace(/(')([^'\\\r\n]*(?:\\.[^'\\\r\n]*)*)('|$)/g, replacer)
    // and then we can do the same for single-line comments, too, which might contain a comma
                                .replace(/(\/\/)(.*)($)/gm, replacer)

    // find the function we're completing on.  we skip matched parenthesis that might be
    // a parameter that is itself a function call.
    // TODO: this gets caught up if you're typing a '(' that is not part of a function call,
    //       e.g. for precedence in arithmetic
    let startOffset = offset - 1
    let parenthesisCount = 1
    while (startOffset > 0 && parenthesisCount > 0) {
        parenthesisCount += docString[startOffset] === ')' ? 1 : (docString[startOffset] === '(' ? -1 : 0)
        startOffset--
    }

    // find completion with same function name
    let args = []
    let functionName = null
    let matchingCompletion = await ycm.getExactMatchingCompletion(uri, doc.positionAt(startOffset), documents)
    if (matchingCompletion) {
        let signatures = []
        try {
            const signaturesStr = matchingCompletion.documentation.split('\n\n')[0].trim()
            for (let signature of signaturesStr.split('\n')) {
                let parametersStr = signature.match(/\((.*)\)/g)[0].slice(1, -1)
                let parameters = []
                for (let parameter of parametersStr.split(',')) {
                    parameters.push({label: parameter.trim()} as ParameterInformation)
                }
                signatures.push({label: signature, parameters: parameters} as SignatureInformation)
            }
        } catch (err) {
            logger('onSignatureHelp unparseable completion', JSON.stringify(err));
        }
        // add 2 to startOffset to move past the '('
        const activeParameter = countArgs(docString, startOffset + 2, offset)
        return {signatures: signatures, activeParameter: activeParameter} as SignatureHelp
    }
    else
        return null
})

// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration(async (change) => {
    let settings = <Settings>change.settings
    loggerInit(settings.ycmd.debug)
    logger(`onDidChangeConfiguration settings`, JSON.stringify(settings))
    try {
        ensureValidConfiguration(settings)
        workspaceConfiguration = settings
    } catch (err) {
        connection.window.showErrorMessage(`[Ycm] ${err.message || err}`)
    }
    await getYcm()
})

function ensureValidConfiguration(settings: Settings) {
    if (!settings.ycmd || !settings.ycmd.path)
        throw new Error('Invalid ycm path')
}

documents.onDidOpen(async (event) => {
    logger(`onDidOpen`, event.document.uri)
    const ycm = await getYcm()
    try {
        await ycm.getReady(event.document.uri, documents)
    } catch (err) {
        logger('onDidOpen error', err)
    }
})

// This handler provides the initial list of the completion items.
connection.onCompletion(async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    logger(`onCompletion: ${textDocumentPosition.textDocument.uri}`)
    const ycm = await getYcm()
    // await ycm.insertLeave(documents.get(textDocumentPosition.textDocument.uri), documents)
    // await ycm.currentIdentifierFinished(documents.get(textDocumentPosition.textDocument.uri), documents)
    // await ycm.readyToParse(documents.get(textDocumentPosition.textDocument.uri), documents)
    try {
        const latestCompletions = await ycm.completion(textDocumentPosition.textDocument.uri, textDocumentPosition.position, documents)
        return latestCompletions
    } catch (err) {
        return null
    }
})

connection.onShutdown(async () => {
    logger('onShutdown')
    await Ycm.reset()
})

// connection.onExit(async () => {
//     logger('onExit')
//     Ycm.reset()
// })

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    return item
})

// connection.onDidOpenTextDocument((params) => {
// 	// A text document got opened in VSCode.
// 	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
// 	// params.text the initial full content of the document.
//     ycm.readyToParse(documents.get(params.textDocument.uri))
// })

// connection.onDidChangeTextDocument((params) => {
// 	// The content of a text document did change in VSCode.
// 	// params.uri uniquely identifies the document.
// 	// params.contentChanges describe the content changes to the document.
// 	connection.logger(`onDidChangeTextDocument: ${JSON.stringify(params.textDocument.version)}`)
// })
/*
connection.onDidCloseTextDocument((params) => {
    // A text document got closed in VSCode.
    // params.uri uniquely identifies the document.
    connection.logger(`${params.uri} closed.`);
});
*/

connection.onNotification('lint', (uri) => {
    getIssues(documents.get(uri))
})

// Listen on the connection
connection.listen()
