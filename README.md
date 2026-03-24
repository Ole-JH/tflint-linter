# TFLint for Visual Studio Code

Inline [tflint](https://github.com/terraform-linters/tflint) diagnostics directly in VS Code. Issues appear as squiggles in your Terraform files as you work — no terminal required.

## Features

- Highlights tflint issues inline as errors, warnings, and informational hints
- Runs automatically on file open and save
- Lints the entire Terraform module (directory), not just the open file
- Clickable rule names in the Problems panel link to the rule's documentation
- Configurable rule exclusions per workspace
- Output channel for debugging (`View → Output → TFLint`)

## Requirements

tflint must be installed and available on your PATH.

**macOS / Linux (Homebrew):**
```bash
brew install tflint
```

**Linux (direct download):**
```bash
curl -s https://raw.githubusercontent.com/terraform-linters/tflint/master/install_linux.sh | bash
```

**Windows (Chocolatey):**
```bash
choco install tflint
```

See the [official installation guide](https://github.com/terraform-linters/tflint#installation) for all options.

## Usage

Open any `.tf` file — the extension activates automatically and runs tflint in the background. Issues appear:

- As **squiggles** in the editor
- In the **Problems panel** (`Ctrl+Shift+M`)
- Grouped by file and severity

Clicking a rule name in the Problems panel opens the rule's documentation page.

## Configuration

All settings are under the `tflint` namespace and can be set in your workspace or user `settings.json`.

| Setting | Type | Default | Description |
|---|---|---|---|
| `tflint.executablePath` | `string` | `"tflint"` | Path to the tflint binary. Set this if tflint is not on VS Code's PATH. |
| `tflint.runOnSave` | `boolean` | `true` | Run tflint every time a `.tf` file is saved. |
| `tflint.runOnOpen` | `boolean` | `true` | Run tflint when a `.tf` file is opened. |
| `tflint.chdir` | `boolean` | `true` | Lint the file's directory instead of a single file. Recommended — tflint is module-aware. |
| `tflint.excludeRules` | `string[]` | `[]` | Rule names to disable, passed as `--disable-rule=<name>`. |

### Examples

**Custom tflint path (e.g. Linuxbrew):**
```json
"tflint.executablePath": "/home/linuxbrew/.linuxbrew/bin/tflint"
```

**Disable specific rules:**
```json
"tflint.excludeRules": [
  "terraform_required_version",
  "terraform_required_providers",
  "terraform_typed_variables"
]
```

**Lint only on save (not on open):**
```json
"tflint.runOnOpen": false
```

## Troubleshooting

**No diagnostics appear**

1. Open `View → Output` and select **TFLint** from the dropdown.
2. Check that tflint runs and exits with code `0` or `2`. Exit code `1` means a fatal tflint error.
3. Verify tflint works manually in the same directory:
   ```bash
   tflint --format=json --chdir=/path/to/your/module
   ```
4. If tflint is not found, set `tflint.executablePath` to the full path of the binary.

**tflint not found**

VS Code may not inherit your shell's PATH. Find the tflint path with `which tflint` and set it explicitly:
```json
"tflint.executablePath": "/usr/local/bin/tflint"
```

**Issues from other files in the module don't appear**

This is expected — tflint reports issues for all files in the module, but VS Code only shows diagnostics for files it has open. Open the relevant `.tf` file to see its diagnostics.

## How It Works

When you open or save a `.tf` file, the extension:

1. Resolves the file's directory as the module root
2. Runs `tflint --format=json --chdir=<module-dir>`
3. Parses the JSON output and maps each issue to its file, line, and column
4. Writes the results to VS Code's diagnostics API

tflint is always run against the **whole module directory** (not a single file) because many rules — such as `terraform_required_providers` — require cross-file analysis.

## Building from Source

```bash
git clone https://github.com/your-org/vscode-tflint
cd vscode-tflint
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

To package as a `.vsix`:
```bash
npm install -g @vscode/vsce
vsce package
```

## License

MIT
