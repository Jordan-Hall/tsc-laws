// Thin VS Code glue: the only file that requires `vscode`. The behaviour is in host.js and the modules it wires.

import * as vscode from 'vscode';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { activateExtension } from './host.js';

function activate(context) {
  activateExtension(vscode, context, { spawn, fs, cpus: os.cpus });
}

function deactivate() {}

export { activate, deactivate };
