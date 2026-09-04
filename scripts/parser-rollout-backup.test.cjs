'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { RELATED_TABLES } = require('./parser-rollout-backup.cjs');

test('parser rollout backup keeps the complete personal notification state', () => {
  for (const table of ['notification_preferences', 'push_subscriptions', 'push_deliveries'])
    assert.equal(RELATED_TABLES.includes(table), true, `${table} must be backed up`);
});
