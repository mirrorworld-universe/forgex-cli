/**
 * ForgeX CLI Store Shim
 *
 * Replaces the frontend Redux Store, providing a compatible interface for
 * modules in sol-sdk that depend on @/store.
 * Primarily used for store.getState().settings calls in src/sol-sdk/rpc/index.ts.
 */

import { loadConfig } from '../config.js';

// Mock Redux store structure
function createMockStore() {
  return {
    getState: () => {
      const config = loadConfig();
      return {
        settings: {
          gasSettings: {
            priorityFee: config.defaultPriorityFee,
            priorityFeeSpeed: 'normal',
          },
          rpcUrl: config.rpcUrl,
          network: config.network,
          solPrice: config.solPrice,
          feeConfig: config.feeConfig,
          token: '',
          walletAddress: '',
          currency: 'SOL',
          isCustomRpc: false,
          theme: { mode: 'dark' },
          language: 'zh',
        },
        wallet: {
          groups: {},
          localGroups: [],
          monitorGroups: [],
          mergedGroups: [],
          notes: {},
          devWallets: {},
        },
        websocket: {
          connected: false,
        },
      };
    },
    dispatch: (_action: any) => {
      // CLI does not need dispatch
    },
    subscribe: (_listener: any) => {
      return () => {};
    },
  };
}

export const store = createMockStore();

// Compatible action creators for the settings slice
export const removeToken = () => ({ type: 'settings/removeToken' });

export default store;
