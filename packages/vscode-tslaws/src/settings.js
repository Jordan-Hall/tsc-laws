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

const LIVE_MODES = ['auto', 'on', 'off'];

/**
 * Whether live results run in the background. `tslaws.liveBackground` is `auto` (the default: on for a project that has a
 * `tslaws.json`, unless the person chose when to run with `tslaws.run`), `on` or `off`. A pause by command wins.
 * @param {{setting?: unknown, hasConfig: boolean, runExplicit: boolean, paused?: boolean}} s
 */
function liveEnabled(s) {
  if (s.paused === true) return false;
  const mode = LIVE_MODES.includes(s.setting) ? s.setting : 'auto';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return s.hasConfig && !s.runExplicit;
}

module.exports.LIVE_MODES = LIVE_MODES;
module.exports.liveEnabled = liveEnabled;
