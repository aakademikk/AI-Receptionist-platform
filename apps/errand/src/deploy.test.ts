import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireTwilioBase } from './config.ts';

/**
 * The staged deploy files (T20). Nothing here installs anything: the tests read the files the
 * deploy and tunnel GATEs will apply and check they say what the spec needs.
 */

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const read = (name: string): string => readFileSync(join(DEPLOY, name), 'utf8');

/** The single rule's `path:` regex, read from the YAML without a YAML library. */
function rulePath(): RegExp {
  const lines = read('tunnel-rule.yml').split('\n').filter((line) => !line.trim().startsWith('#') && line.trim() !== '');
  const path = lines.find((line) => line.trim().startsWith('path:'));
  assert.ok(path, 'tunnel rule has a path');
  return new RegExp(path.split('path:')[1]!.trim());
}

describe('tunnel-rule.yml (must-do 22)', () => {
  it('is one rule for the public hostname, to port 3003', () => {
    const body = read('tunnel-rule.yml').split('\n').filter((line) => !line.trim().startsWith('#') && line.trim() !== '');
    assert.equal(body.filter((line) => line.trim().startsWith('- ')).length, 1);
    assert.ok(body.some((line) => line.trim() === '- hostname: receptionist.atwoodsystems.co.uk'));
    assert.ok(body.some((line) => line.trim() === 'service: http://localhost:3003'));
  });

  it('matches the three errand paths and not /relay, /api/health or /errand/health', () => {
    const path = rulePath();
    for (const yes of ['/errand/twiml', '/errand/status', '/errand/ws']) assert.equal(path.test(yes), true, yes);
    for (const no of ['/relay', '/api/health', '/errand/health', '/errand/twiml/x', '/x/errand/ws', '/errand/', '/']) assert.equal(path.test(no), false, no);
  });
});

describe('unit files and wrapper', () => {
  it('the seven files exist', () => {
    for (const name of ['atwood-errand.service', 'errand-prune.service', 'errand-prune.timer', 'errand', 'keystore-rows.tsv', 'tunnel-rule.yml', 'RUNBOOK.md']) {
      assert.ok(existsSync(join(DEPLOY, name)), name);
    }
  });

  it('atwood-errand.service launches through with-secrets with the tarball Node, port 3003 and the hardening', () => {
    const unit = read('atwood-errand.service');
    const exec = unit.split('\n').find((line) => line.startsWith('ExecStart='))!;
    assert.ok(exec.includes('with-secrets --as errand-caller'));
    assert.ok(exec.includes('/home/col/.local/node/bin/node --experimental-strip-types src/server.ts'));
    for (const line of ['Environment=ERRAND_PORT=3003', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'LimitCORE=0', 'Restart=always']) {
      assert.ok(unit.split('\n').includes(line), line);
    }
    assert.equal(unit.includes('.env'), false, 'no env file');
  });

  it('the prune timer runs daily at 04:40, after the 04:16 backup', () => {
    assert.ok(read('errand-prune.timer').split('\n').includes('OnCalendar=*-*-* 04:40:00'));
    assert.ok(read('errand-prune.service').includes('ExecStart=/home/col/.local/bin/errand prune'));
  });

  it('the errand wrapper runs the CLI through with-secrets and is executable', () => {
    const wrapper = read('errand');
    assert.ok(wrapper.startsWith('#!/bin/sh'));
    assert.ok(wrapper.includes('with-secrets --as errand-caller'));
    assert.ok(wrapper.includes('apps/errand/src/cli.ts "$@"'));
    assert.ok((statSync(join(DEPLOY, 'errand')).mode & 0o111) !== 0);
  });

  it('keystore rows are in the live map layout (kind, consumer, field, value) and carry no value', () => {
    const rows = read('keystore-rows.tsv')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('\t'));
    const kinds = new Set(['consumer', 'grant', 'launch', 'restart', 'health', 'status']);
    assert.ok(rows.every((row) => row.length === 4 && kinds.has(row[0]!) && row[1] === 'errand-caller'));
    assert.deepEqual(rows.filter((row) => row[0] === 'consumer').map((row) => row[2]), ['service']);
    const grants = rows.filter((row) => row[0] === 'grant');
    assert.deepEqual(grants.map((row) => row[2]), ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'GOOGLE_API_KEY']);
    assert.ok(grants.every((row) => row[3] === row[2]));
    for (const kind of ['launch', 'restart', 'health', 'status']) assert.ok(rows.some((row) => row[0] === kind), kind);
    assert.deepEqual(rows.filter((row) => row[0] === 'launch').map((row) => row[2]), ['~/.config/systemd/user/atwood-errand.service', '~/.local/bin/errand']);
    assert.ok(rows.filter((row) => row[0] === 'launch').every((row) => row[3] === 'with-secrets --as errand-caller'));
    assert.equal(/[A-Z_]+=\S/.test(read('keystore-rows.tsv')), false, 'no NAME=value');
  });

  it('the unit and the wrapper use the live with-secrets path and set the Dublin Twilio base (T22)', () => {
    for (const name of ['atwood-errand.service', 'errand']) {
      const text = read(name);
      assert.ok(text.includes('/home/col/.sam/bin/with-secrets --as errand-caller --'), name);
      assert.equal(text.includes('.local/bin/with-secrets'), false, name);
    }
    const unitBase = read('atwood-errand.service').match(/^Environment=TWILIO_API_BASE_URL=(\S+)$/m)?.[1];
    assert.ok(unitBase, 'unit sets TWILIO_API_BASE_URL');
    assert.doesNotThrow(() => requireTwilioBase({ TWILIO_API_BASE_URL: unitBase }));
    assert.equal(read('errand').match(/^TWILIO_API_BASE_URL=(\S+) exec /m)?.[1], unitBase);
  });
});

describe('RUNBOOK.md', () => {
  it('names each GATE step, the rollback, the restore and the base commit', () => {
    const runbook = read('RUNBOOK.md');
    for (const gate of ['T22', 'T23', 'T24', 'T25', 'T26', 'T27', 'T28', 'T29', 'T30', 'T31', 'T32', 'T33']) assert.ok(runbook.includes(gate), gate);
    for (const part of ['## Rollback', '## Restore', '2ea20b869167128f9623a8f3733cdc79e6354292', 'errand service down', '/relay` 426', '/api/health` 200']) {
      assert.ok(runbook.includes(part), part);
    }
  });
});
