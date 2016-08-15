'use strict';

import {
  IPCMessageReader, IPCMessageWriter, ServerCapabilities, SymbolKind, Range,
  createConnection, IConnection, TextDocumentSyncKind,
  TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity, CodeLens,
  InitializeResult, SymbolInformation, Files, ResponseError, InitializeError
} from 'vscode-languageserver';

import * as refractUtils from './refractUtils';
import {utf16to8} from './utfUtils';

import {parse} from './parser';

let lodash = require('lodash');
let apiDescriptionMixins = require('lodash-api-description');
const dredd = require('dredd');

let refractDocuments = new Map();
apiDescriptionMixins(lodash);

const getHelpUrl = (section: string): string => {
  return `https://github.com/XVincentX/vscode-apielements/blob/master/TROUBLESHOT.md${section}`
}

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let documents: TextDocuments = new TextDocuments();
documents.listen(connection);

let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
  workspaceRoot = params.rootPath;

  const capabilities: ServerCapabilities = {
    textDocumentSync: documents.syncKind,
    documentSymbolProvider: true,
    codeLensProvider: {
      resolveProvider: true
    }
  }

  return <InitializeResult>{
    capabilities: capabilities
  };

});

documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});


documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

interface Settings {
  apiElements: ApiElementsSettings;
};

interface ApiElementsSettings {
  parser: ParserSettings;
};

interface ParserSettings {
  exportSourcemap: boolean;
  json: boolean;
  requireBlueprintName: boolean;
  type: string;
};

let currentSettings: ApiElementsSettings;

connection.onDidChangeConfiguration((change) => {
  currentSettings = lodash.cloneDeep(change.settings.apiElements);
  // Revalidate any open text documents
  documents.all().forEach(validateTextDocument);
});

function validateTextDocument(textDocument: TextDocument): void {
  let diagnostics: Diagnostic[] = [];
  let text = textDocument.getText();

  parse(text, currentSettings.parser)
    .then(output => output, (error) => error.result)
    .then(refractOutput => {

      refractDocuments.set(textDocument.uri.toString(), refractOutput);
      let annotations = lodash.filterContent(refractOutput, { element: 'annotation' });

      const utf8Text = utf16to8(text);
      const documentLines = utf8Text.split(/\r?\n/g);

      lodash.forEach(annotations, (annotation) => {

        const lineReference = refractUtils.createLineReferenceFromSourceMap(
          annotation.attributes.sourceMap,
          text,
          documentLines
        );

        diagnostics.push(<Diagnostic>{
          severity: ((lodash.head(annotation.meta.classes) === 'warning') ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error),
          code: annotation.attributes.code,
          range: Range.create(
            lineReference.startRow,
            lineReference.startIndex,
            lineReference.endRow,
            lineReference.endIndex
          ),
          message: annotation.content,
          source: 'fury'
        });

      });

      connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    })

}

connection.onDocumentSymbol((symbolParam) => {
  try {
    if (currentSettings.parser.exportSourcemap === false) {
      connection.window.showWarningMessage('\
        The current parser options have source maps disabled.\
        Without those, it\'s not possible to generate document symbol.\
        ', { title: 'More Info' }).then(() => {
          connection.sendNotification({ method: 'openUrl' }, getHelpUrl('#no-sourcemaps-enabled'));
        });

      return Promise.resolve([]); // I cannot let you navigate if I have no source map.
    }

    const textDocument = utf16to8(documents.get(symbolParam.textDocument.uri).getText());
    const documentLines = textDocument.split(/\r?\n/g);
    const refractOutput = refractDocuments.get(symbolParam.textDocument.uri.toString());

    const symbolArray = refractUtils.extractSymbols(refractOutput, textDocument, documentLines);
    return Promise.resolve(symbolArray);
  } catch (err) {
    connection.window.showErrorMessage(err.message);
  }


});

connection.onRequest({ method: 'parserOutput' }, (code: string) => {
  return parse(code, currentSettings.parser);
});

let promise = undefined;

connection.onCodeLens((params) => {

  const config = {
    silent: true,
    server: 'https://plutonium.apiary-services.com',
    data: {
      'doc.apib': documents.get(params.textDocument.uri).getText()
    }
  };

  var d = new dredd(config);
  promise = new Promise((resolve, reject) => {
    d.run((err, stats) => {
      if (err)
        return reject(err);
      return resolve(stats);
    });
  });

  return [CodeLens.create(Range.create(0, 1, 0, 1), {})]
});

connection.onCodeLensResolve((src) => {
  return promise.then((stats) => {
    src.command = {
      title: `Dredd - executed ${stats.tests} - ${stats.passes} passes - ${stats.failures} fails - ${stats.skipped} skipped`,
      command: 'apiElements.dredd.showReport',
      arguments: [1, 2, 3, 4]
    }
    return src;
  })
})

connection.listen();
