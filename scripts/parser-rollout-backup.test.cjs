'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { RELATED_TABLES } = require('./parser-rollout-backup.cjs');

test('parser rollout backup keeps the complete personal notification state', () => {
  for (const table of ['notification_preferences', 'push_subscriptions', 'push_deliveries'])
    assert.equal(RELATED_TABLES.includes(table), true, `${table} must be backed up`);
});

test('parser rollout backup keeps news source links and all disclosure domains', () => {
  for (const table of [
    'source_items',
    'news_articles',
    'news_items',
    'proxy_solicitations',
    'proxy_agenda_items',
    'tender_offers',
    'tender_offer_securities',
  ]) {
    assert.equal(RELATED_TABLES.includes(table), true, `${table} must be backed up`);
  }
});
