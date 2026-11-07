// Run the two unmodified methods extracted from Qwen CLI 0.14.0. No runtime/model process.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/qwen-0.14.0-questions.json', import.meta.url)));
const outcomes = { ProceedOnce: 'once', ProceedAlways: 'always', Cancel: 'cancel' };
const invocation = new Function('ToolConfirmationOutcome', '__name', `return ({${fixture.confirmationMethod}})`)(outcomes, fn => fn);
invocation.params = { questions: [{ header: 'Choice', question: 'Choose', options: [{ label: 'A' }] }] };
invocation.userAnswers = {};
invocation.wasAnswered = false;
const details = await invocation.getConfirmationDetails();
const controller = new Function('ToolConfirmationOutcome', 'InputFormat', `return ({${fixture.responseMethod}})`)(outcomes, { STREAM_JSON: 'stream-json' });
Object.assign(controller, {
  context: { config: { getInputFormat: () => 'stream-json' } }, pendingOutgoingRequests: new Set(['call']),
  buildPermissionSuggestions: () => [], debugLogger: { error: error => { throw error; } },
  sendControlRequest: async () => ({ subtype: 'success', response: { behavior: 'allow', updatedInput: { answers: { '0': 'A' } } } }),
});
const tool = { request: { name: 'ask_user_question', callId: 'call', args: invocation.params }, confirmationDetails: details };
await controller.handleOutgoingPermissionRequest(tool);
assert.equal(invocation.wasAnswered, true);
assert.deepEqual(tool.request.args.answers, { '0': 'A' });
assert.deepEqual(invocation.userAnswers, {}); // CLI drops the payload before onConfirm.
assert.equal(controller.pendingOutgoingRequests.size, 0);
controller.sendControlRequest = async () => ({ subtype: 'success', response: { behavior: 'deny', message: 'Use next turn' } });
await controller.handleOutgoingPermissionRequest(tool);
assert.equal(invocation.wasAnswered, false);
console.log('Qwen 0.14.0: lost-answer contract reproduced; deny closes original confirmation.');
