'use strict';

// Reads the run settings. `tslaws.run` replaces the boolean `tslaws.runOnSave`; the old setting still decides when the
// new one has not been set, so nobody's configuration changes meaning. Pure.

const RUN_MODES = ['onType', 'onSave', 'manual'];

/**
 * @param {{explicitRun?: unknown, runOnSave?: unknown}} s `explicitRun` is `tslaws.run` only when the user set it
 * @returns {'onType' | 'onSave' | 'manual'}
 */
function resolveRunMode(s) {
  if (RUN_MODES.includes(s.explicitRun)) return s.explicitRun;
  return s.runOnSave === false ? 'manual' : 'onSave';
}

/** The value of a setting the user set, at any level, or undefined when it is only the default. */
function explicitValue(inspected) {
  if (inspected === undefined || inspected === null) return undefined;
  return inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue;
}

/** Whole numbers within bounds, else the fallback. */
function clampInt(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

module.exports = { RUN_MODES, resolveRunMode, explicitValue, clampInt };
