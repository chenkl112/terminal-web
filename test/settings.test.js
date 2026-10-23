import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, turnSettings } from '../shared/settings.js';

const models = [
  { model: 'a', serviceTiers: [{ id: 'priority' }], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] },
  { model: 'b', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
];
test('switching models reconciles unsupported effort and preserves selected permission', () => {
  const result = validateSettings({ model: 'a', effort: 'ultra', permissionMode: 'read-only' }, { model: 'b' }, models);
  assert.deepEqual(result, { model: 'b', effort: 'medium', permissionMode: 'read-only', fast: false, mode: 'default' });
  assert.equal(validateSettings(result, { effort: 'low' }, models).effort, 'low');
});
test('unknown models, explicit unsupported depths and permission modes are rejected', () => {
  const current = { model: 'b', effort: 'medium' };
  for (const patch of [{ model: 'missing' }, { effort: 'ultra' }, { permissionMode: 'unknown' }]) {
    assert.throws(() => validateSettings(current, patch, models), error => error.status === 400);
  }
});
test('selected model, effort, sandbox and approval policy are transmitted together', () => {
  const base = { model: 'b', effort: 'medium' };
  const full = turnSettings({ ...base, permissionMode: 'full-access' });
  assert.deepEqual(full, { model: 'b', effort: 'medium', serviceTier: 'default', collaborationMode: { mode: 'default', settings: { model: 'b', reasoning_effort: 'medium', developer_instructions: null } }, sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' });
  const read = turnSettings({ ...base, permissionMode: 'read-only' });
  assert.equal(read.sandboxPolicy.type, 'readOnly');
  assert.equal(read.approvalPolicy, 'on-request');
  const normal = turnSettings({ ...base, permissionMode: 'workspace-write' });
  assert.equal(normal.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(normal.approvalPolicy, 'on-request');
});

test('Fast and plan settings persist, reset unsupported Fast on model changes, and send explicit native overrides', () => {
  const enabled = validateSettings({ model: 'a', effort: 'high', permissionMode: 'full-access' }, { fast: true, mode: 'plan' }, models);
  assert.equal(enabled.fast, true); assert.equal(turnSettings(enabled).serviceTier, 'priority');
  assert.equal(turnSettings(enabled).collaborationMode.mode, 'plan');
  const disabled = validateSettings(enabled, { fast: false, mode: 'default' }, models);
  assert.equal(turnSettings(disabled).serviceTier, 'default');
  assert.equal(turnSettings(disabled).collaborationMode.mode, 'default');
  assert.equal(validateSettings(enabled, { model: 'b' }, models).fast, false);
  assert.throws(() => validateSettings(disabled, { model: 'b', fast: true }, models), error => error.status === 400);
  assert.throws(() => validateSettings(disabled, { fast: 'yes' }, models), error => error.status === 400);
  assert.throws(() => validateSettings(disabled, { mode: 'invalid' }, models), error => error.status === 400);
});
