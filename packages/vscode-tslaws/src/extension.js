'use strict';

// Thin VS Code glue: the only file that requires `vscode`. The behaviour is in host.js and the modules it wires.

const vscode = require('vscode');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { activateExtension } = require('./host.js');

function activate(context) {
  activateExtension(vscode, context, { spawn, fs });
}

function deactivate() {}

module.exports = { activate, deactivate };
