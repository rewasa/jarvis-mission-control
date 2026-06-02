import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const python = String.raw`
import contextlib
import io
import json
import pathlib
import sys

repo = pathlib.Path.cwd()
sys.path.insert(0, str(repo / 'server' / 'workers'))
import hermes_worker

class FakeAgent:
    def __init__(self):
        self.steers = []
    def steer(self, text):
        self.steers.append(text)
        return True

agent = FakeAgent()
request = {
    'id': 'steer-request',
    'type': 'chat.steer',
    'taskId': 'task-123',
    'sessionId': 'task-123',
    'message': 'Inspect the latest Kanban comments before continuing.',
}

with hermes_worker.ACTIVE_TASKS_LOCK:
    hermes_worker.ACTIVE_TASKS['task-123'] = 'run-123'
    hermes_worker.ACTIVE_AGENTS['task-123'] = agent

buf = io.StringIO()
original_out = hermes_worker.PROTOCOL_OUT
try:
    hermes_worker.PROTOCOL_OUT = buf
    hermes_worker._handle_request(request)
finally:
    hermes_worker.PROTOCOL_OUT = original_out
    with hermes_worker.ACTIVE_TASKS_LOCK:
        hermes_worker.ACTIVE_TASKS.clear()
        hermes_worker.ACTIVE_AGENTS.clear()
        hermes_worker.PENDING_INTERRUPTS.clear()

lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
print(json.dumps({'lines': lines, 'steers': agent.steers}, ensure_ascii=False))
`;

const { stdout } = await execFileAsync('python3', ['-c', python], {
  cwd: process.cwd(),
  maxBuffer: 1024 * 1024,
});

const result = JSON.parse(stdout.trim()) as {
  lines: Array<{ id: string; type: string; data?: { steered?: boolean } }>;
  steers: string[];
};

assert.deepEqual(result.steers, ['Inspect the latest Kanban comments before continuing.']);
assert.deepEqual(result.lines, [
  { id: 'steer-request', type: 'result', data: { steered: true } },
]);
console.log('hermes-worker steer smoke tests passed');
