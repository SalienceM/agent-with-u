"""Isolated fake Claude stream-json process. No model, settings or user directory reads."""
import json
import sys

def read():
    return json.loads(sys.stdin.readline())

def write(data):
    print(json.dumps(data), flush=True)

init = read()
assert init['request']['subtype'] == 'initialize'
write({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': init['request_id'], 'response': {}}})
user = read()
assert user['type'] == 'user'
write({'type': 'control_request', 'request_id': 'request-7', 'request': {'subtype': 'can_use_tool',
    'tool_use_id': 'tool-7', 'tool_name': 'AskUserQuestion', 'input': {'questions': [
        {'question': 'Choose', 'header': 'Mode', 'options': [{'label': 'A'}, {'label': 'B'}], 'multiSelect': True}]}}})
answer = read()
assert answer['response']['request_id'] == 'request-7'
assert answer['response']['response']['updatedInput']['answers'] == {'Choose': 'A, B'}
write({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'answer-consumed'}]}})
write({'type': 'result', 'subtype': 'success', 'session_id': 'isolated-native', 'is_error': False})
