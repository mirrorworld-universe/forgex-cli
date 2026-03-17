/**
 * ForgeX CLI Solana Connection Adapter
 *
 * Replaces the frontend useConnection hook, providing direct Connection creation.
 */

import { Connection, Commitment } from '@solana/web3.js';
import { loadConfig } from '../config.js';

let _connection: Connection | null = null;
let _currentRpcUrl = '';

/**
 * Get Solana Connection
 * Caches instance, only rebuilds when RPC URL changes
 */
export function getConnection(commitment: Commitment = 'processed'): Connection {
  const config = loadConfig();
  const rpcUrl = config.rpcUrl;

  if (!rpcUrl) {
    throw new Error('RPC URL not configured. Please run: forgex config set rpcUrl <your-rpc-url>');
  }

  if (!_connection || _currentRpcUrl !== rpcUrl) {
    _connection = new Connection(rpcUrl, commitment);
    _currentRpcUrl = rpcUrl;
  }

  return _connection;
}

/**
 * Create a new Connection (without caching)
 */
export function createConnection(
  rpcUrl?: string,
  commitment: Commitment = 'processed'
): Connection {
  const url = rpcUrl || loadConfig().rpcUrl;
  if (!url) {
    throw new Error('RPC URL not configured');
  }
  return new Connection(url, commitment);
}

/**
 * Reset connection cache
 */
export function resetConnection(): void {
  _connection = null;
  _currentRpcUrl = '';
}
