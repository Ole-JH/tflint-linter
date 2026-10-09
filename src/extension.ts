import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface TflintRange {
  filename: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface TflintIssue {
  rule: { name: string; severity: string; link: string };
  message: string;
  range: TflintRange;
  fixable: boolean;
}

interface TflintError {
  message: string;
  severity?: string;
}

interface TflintOutput {
  issues: TflintIssue[];
  errors: TflintError[];
}

let installWarningShown = false;
let outputChannel: vscode.OutputChannel;

// Common locations where tflint may be installed
const EXTRA_PATH_DIRS = [
  '/home/linuxbrew/.linuxbrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/opt/homebrew/bin',
];

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('TFLint');
  context.subscriptions.push(outputChannel);

  const diagnosticCollection = vscode.languages.createDiagnosticCollection('tflint');
  context.subscriptions.push(diagnosticCollection);

  outputChannel.appendLine('TFLint extension activated');

  context.subscriptions.push(
    vscode.commands.registerCommand('tflint.disableRule', async (ruleName: string, uri: vscode.Uri) => {
      const config = vscode.workspace.getConfiguration('tflint', uri);
      const current = config.get<string[]>('excludeRules', []);
      if (!current.includes(ruleName)) {
        await config.update('excludeRules', [...current, ruleName], vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`tflint: disabled rule "${ruleName}"`);
      }
    })
  );

  const cfg = (doc: vscode.TextDocument) => vscode.workspace.getConfiguration('tflint', doc.uri);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (cfg(doc).get<boolean>('runOnOpen') && isTerraformDoc(doc)) {
        runTflint(doc, diagnosticCollection);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (cfg(doc).get<boolean>('runOnSave') && isTerraformDoc(doc)) {
        runTflint(doc, diagnosticCollection);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      diagnosticCollection.delete(doc.uri);
    })
  );

  // Quick fix: "Disable tflint rule: <name>" adds the rule to excludeRules in settings
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'terraform' }, { pattern: '**/*.tf' }],
      new TflintQuickFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  // Run on already-open terraform files at activation time
  vscode.workspace.textDocuments
    .filter(isTerraformDoc)
    .forEach(doc => runTflint(doc, diagnosticCollection));
}

class TflintQuickFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter(d => d.source === 'tflint' && typeof d.code === 'object' && d.code !== null)
      .map(d => {
        const ruleName = (d.code as { value: string }).value;
        const action = new vscode.CodeAction(
          `Disable tflint rule: ${ruleName}`,
          vscode.CodeActionKind.QuickFix
        );
        action.command = {
          command: 'tflint.disableRule',
          title: `Disable tflint rule: ${ruleName}`,
          arguments: [ruleName, document.uri],
        };
        action.diagnostics = [d];
        return action;
      });
  }
}

export function deactivate(): void {
  // DiagnosticCollection disposed via context.subscriptions
}

function isTerraformDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'terraform' || doc.fileName.endsWith('.tf');
}

function buildEnv(): NodeJS.ProcessEnv {
  const existingPath = process.env.PATH ?? '';
  const extraPaths = EXTRA_PATH_DIRS.filter(d => !existingPath.includes(d)).join(':');
  return {
    ...process.env,
    PATH: extraPaths ? `${existingPath}:${extraPaths}` : existingPath,
  };
}

function resolveConfigFile(doc: vscode.TextDocument, configuredPath: string): string | undefined {
  const moduleDir = path.dirname(doc.uri.fsPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const workspaceRoot = workspaceFolder?.uri.fsPath;

  if (configuredPath) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(workspaceRoot ?? moduleDir, configuredPath);
  }

  if (!workspaceRoot) {
    return undefined;
  }

  const relativeModulePath = path.relative(workspaceRoot, moduleDir);
  if (relativeModulePath.startsWith('..') || path.isAbsolute(relativeModulePath)) {
    return undefined;
  }

  let currentDir = moduleDir;
  while (true) {
    const candidate = path.join(currentDir, '.tflint.hcl');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (currentDir === workspaceRoot) {
      return undefined;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

function runTflint(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): void {
  const config = vscode.workspace.getConfiguration('tflint', doc.uri);
  const executable = config.get<string>('executablePath', 'tflint');
  const useChdir = config.get<boolean>('chdir', true);
  const excludeRules = config.get<string[]>('excludeRules', []);
  const configFile = resolveConfigFile(doc, config.get<string>('configFile', '').trim());

  // tflint lints one module (directory) at a time — use the file's directory, not the workspace root
  const spawnCwd = path.dirname(doc.uri.fsPath);

  const baseArgs = useChdir
    ? ['--format=json', `--chdir=${spawnCwd}`]
    : ['--format=json', doc.uri.fsPath];

  const configArgs = configFile ? [`--config=${configFile}`] : [];
  const disableArgs = excludeRules.map(rule => `--disable-rule=${rule}`);
  const args = [...baseArgs, ...configArgs, ...disableArgs];

  outputChannel.appendLine(`\n[tflint] Running: ${executable} ${args.join(' ')}`);
  outputChannel.appendLine(`[tflint] spawn cwd: ${spawnCwd}`);

  let stdout = '';
  let stderr = '';

  let proc: cp.ChildProcess;
  try {
    proc = cp.spawn(executable, args, {
      shell: false,
      cwd: spawnCwd,
      env: buildEnv(),
    });
  } catch (err) {
    outputChannel.appendLine(`[tflint] spawn threw: ${err}`);
    showInstallWarning(executable);
    return;
  }

  proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  proc.on('error', (err: NodeJS.ErrnoException) => {
    outputChannel.appendLine(`[tflint] process error: ${err.message} (code: ${err.code})`);
    if (err.code === 'ENOENT') {
      showInstallWarning(executable);
    } else {
      vscode.window.showErrorMessage(`tflint error: ${err.message}`);
    }
  });

  proc.on('close', (code: number | null) => {
    outputChannel.appendLine(`[tflint] exit code: ${code}`);
    if (stderr) {
      outputChannel.appendLine(`[tflint] stderr: ${stderr}`);
    }
    outputChannel.appendLine(`[tflint] stdout: ${stdout}`);

    // Exit codes: 0 = no issues, 2 = issues found (normal), 1 = fatal error
    if (code === 1) {
      vscode.window.showErrorMessage(
        `tflint exited with an error: ${stderr || stdout || 'unknown error'}`
      );
      return;
    }
    parseTflintOutput(stdout, doc, spawnCwd, collection);
  });
}

function parseTflintOutput(
  raw: string,
  doc: vscode.TextDocument,
  spawnCwd: string,
  collection: vscode.DiagnosticCollection
): void {
  if (!raw.trim()) {
    collection.set(doc.uri, []);
    return;
  }

  let output: TflintOutput;
  try {
    output = JSON.parse(raw) as TflintOutput;
  } catch {
    outputChannel.appendLine(`[tflint] JSON parse error. Raw output: ${raw.slice(0, 500)}`);
    vscode.window.showWarningMessage(
      `tflint produced unexpected output: ${raw.slice(0, 200)}`
    );
    return;
  }

  outputChannel.appendLine(`[tflint] issues: ${output.issues.length}, errors: ${output.errors.length}`);

  // Aggregate diagnostics by absolute file path.
  // Filenames in tflint JSON are relative to the process's cwd (spawnCwd).
  const diagMap = new Map<string, vscode.Diagnostic[]>();

  for (const issue of output.issues) {
    const absPath = path.isAbsolute(issue.range.filename)
      ? issue.range.filename
      : path.resolve(spawnCwd, issue.range.filename);

    outputChannel.appendLine(`[tflint] issue in: ${absPath} — ${issue.message}`);

    if (!diagMap.has(absPath)) {
      diagMap.set(absPath, []);
    }
    diagMap.get(absPath)!.push(issueToDiagnostic(issue));
  }

  for (const [filePath, diags] of diagMap) {
    collection.set(vscode.Uri.file(filePath), diags);
  }

  // Clear diagnostics for the current file if tflint reported no issues for it
  if (!diagMap.has(doc.uri.fsPath)) {
    collection.set(doc.uri, []);
  }

  for (const err of output.errors) {
    outputChannel.appendLine(`[tflint] tflint error: ${err.message}`);
    vscode.window.showWarningMessage(`tflint: ${err.message}`);
  }
}

function issueToDiagnostic(issue: TflintIssue): vscode.Diagnostic {
  const { start, end } = issue.range;

  // tflint ranges are 1-based; VS Code Range is 0-based
  const range = new vscode.Range(
    new vscode.Position(start.line - 1, start.column - 1),
    new vscode.Position(end.line - 1, Math.max(0, end.column - 1))
  );

  const diag = new vscode.Diagnostic(range, issue.message, toSeverity(issue.rule.severity));
  diag.source = 'tflint';
  diag.code = {
    value: issue.rule.name,
    target: vscode.Uri.parse(issue.rule.link),
  };

  return diag;
}

function toSeverity(s: string): vscode.DiagnosticSeverity {
  switch (s.toLowerCase()) {
    case 'error':   return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'notice':  return vscode.DiagnosticSeverity.Information;
    default:        return vscode.DiagnosticSeverity.Hint;
  }
}

function showInstallWarning(executablePath: string): void {
  if (installWarningShown) { return; }
  installWarningShown = true;

  vscode.window.showWarningMessage(
    `tflint not found at "${executablePath}". Install tflint or configure tflint.executablePath.`,
    'Open Settings',
    'Installation Guide'
  ).then(choice => {
    if (choice === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'tflint.executablePath');
    } else if (choice === 'Installation Guide') {
      vscode.env.openExternal(
        vscode.Uri.parse('https://github.com/terraform-linters/tflint#installation')
      );
    }
  });
}
