import { defineConfig } from 'vitest/config';

/** Unit suites that never touch the database — runnable without MongoDB. */
const pureTests = [
  'test/agent-runner.test.ts',
  'test/agentAuth.test.ts',
  'test/authCookie.test.ts',
  'test/bearer.test.ts',
  'test/boundedMap.test.ts',
  'test/router.test.ts',
  'test/canvasLayout.test.ts',
  'test/clientIpRelay.test.ts',
  'test/cloudBilling.test.ts',
  'test/companyPool.test.ts',
  'test/composioConnect.test.ts',
  'test/configDocs.test.ts',
  'test/entrypoint.test.ts',
  'test/examples.test.ts',
  'test/feedCursor.test.ts',
  'test/graphStore.pure.test.ts',
  'test/graphSearch.pure.test.ts',
  'test/forward.test.ts',
  'test/ghWrapper.test.ts',
  'test/gke-driver.test.ts',
  'test/hubBoundaries.test.ts',
  'test/hubMcpCache.test.ts',
  'test/hubPublicUrl.test.ts',
  'test/labels.test.ts',
  'test/liveRefresh.test.ts',
  'test/mentions.test.ts',
  'test/ponytailDebt.test.ts',
  'test/readThreadOnce.test.ts',
  'test/toolFields.test.ts',
  'test/publicFetch.test.ts',
  'test/refreshScheduler.test.ts',
  'test/retryingMemo.test.ts',
  'test/review73.test.ts',
  'test/roomStatus.test.ts',
  'test/shutdown.test.ts',
  'test/roomTemplates.test.ts',
  'test/slack-mrkdwn.test.ts',
  'test/vertex.test.ts',
  'test/webFetchTimeouts.test.ts',
  'test/panelLoading.test.ts',
  'test/activityIndexes.test.ts',
  'test/panelTabsNoReload.test.ts',
  'test/payer.test.ts',
  'test/webSearch.test.ts',
  'test/workers.test.ts',
  'test/cloudAgentShrink.test.ts',
];

const shared = {
  testTimeout: 30_000,
  hookTimeout: 30_000,
  // No GCE metadata server locally; stops google-auth probing it.
  env: { METADATA_SERVER_DETECTION: 'none' },
};

export default defineConfig({
  test: {
    // ponytail: modest coverage floors in CI (55/50/40/55); raise as suite coverage grows
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 55,
        functions: 50,
        branches: 40,
        statements: 55,
      },
    },
    projects: [
      {
        test: {
          ...shared,
          name: 'pure',
          include: pureTests,
        },
      },
      {
        test: {
          ...shared,
          name: 'mongo',
          include: ['test/**/*.test.ts'],
          exclude: pureTests,
          globalSetup: ['test/globalSetup.ts'],
        },
      },
    ],
  },
});
