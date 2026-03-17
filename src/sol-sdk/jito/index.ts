import axios, { AxiosInstance } from 'axios';

import {
  VersionedTransaction,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
/**
 * @typedef {Object} JsonRpcRequest
 * @property {string} jsonrpc
 * @property {number} id
 * @property {string} method
 * @property {any[]} params
 */

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

export const endpoints = [
  'https://mainnet.block-engine.jito.wtf/api/v1',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1',
];

export enum BundleStatus {
  SENT = 'sent',
  CONFIRMED = 'confirmed',
  TIMEOUT = 'timeout',
  PROCESSED = 'processed',
  FINALIZED = 'finalized',
  FAILED = 'failed',
}

export const JITO_TIP_ACCOUNT = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

class JitoJsonRpcClient {
  private uuid: string | undefined;
  private client: AxiosInstance;
  private currentEndpointIndex: number = 0;

  constructor() {
    this.client = axios.create({
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private getNextEndpoint(): string {
    this.currentEndpointIndex = (this.currentEndpointIndex + 1) % endpoints.length;
    return endpoints[this.currentEndpointIndex];
  }

  async sendRequest(endpoint: string, method: string, params?: any[]): Promise<JsonRpcResponse> {
    const data = {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: params || [],
    };

    // Try all endpoints, rotate on 429
    let lastError: any;
    for (let attempt = 0; attempt < endpoints.length; attempt++) {
      const baseUrl = endpoints[(this.currentEndpointIndex + attempt) % endpoints.length];
      const url = `${baseUrl}${endpoint}`;

      try {
        const response = await this.client.post(url, data);
        // Update current endpoint index after success
        this.currentEndpointIndex = (this.currentEndpointIndex + attempt) % endpoints.length;
        return response.data;
      } catch (error: any) {
        lastError = error;
        if (error?.response?.status === 429) {
          console.log(`Jito endpoint ${baseUrl} rate limited (429), trying next...`);
          continue;
        }
        // Non-429 errors throw directly
        console.error('jito request error', error);
        return Promise.reject({
          success: false,
          error: 'Jito request error: An unexpected error occurred',
        });
      }
    }

    // All endpoints returned 429, rotate to next and retry after wait
    this.getNextEndpoint();
    console.error('All Jito endpoints rate limited (429)');
    return Promise.reject({
      success: false,
      error: 'Jito request error: All endpoints rate limited (429)',
    });
  }

  async getTipAccounts(): Promise<JsonRpcResponse> {
    try {
      const endpoint = this.uuid ? `/bundles?uuid=${this.uuid}` : '/bundles';
      return this.sendRequest(endpoint, 'getTipAccounts');
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async sendTransaction(tx: string) {
    try {
      const endpoint = `/transactions?uuid=${this.uuid}`;
      return this.sendRequest(endpoint, 'sendTransaction', [
        tx,
        {
          encoding: 'base64',
        },
      ]);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async sendBundle(params: any[]): Promise<JsonRpcResponse> {
    try {
      const endpoint = this.uuid ? `/bundles?uuid=${this.uuid}` : '/bundles';
      return await this.sendRequest(endpoint, 'sendBundle', params).catch(error => {
        console.error(error);
        throw error;
      });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async sendTxn(params: any[], bundleOnly = false): Promise<JsonRpcResponse> {
    let endpoint = '/transactions';
    const queryParams = [];

    if (bundleOnly) {
      queryParams.push('bundleOnly=true');
    }

    if (this.uuid) {
      queryParams.push(`uuid=${this.uuid}`);
    }

    if (queryParams.length > 0) {
      endpoint += `?${queryParams.join('&')}`;
    }

    try {
      return this.sendRequest(endpoint, 'sendTransaction', params);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async getInFlightBundleStatuses(params: string[][]): Promise<JsonRpcResponse> {
    try {
      const endpoint = this.uuid ? `/bundles?uuid=${this.uuid}` : '/bundles';
      return this.sendRequest(endpoint, 'getInflightBundleStatuses', params);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async getBundleStatuses(params: string[]): Promise<BundleStatusResponse> {
    try {
      const response = await this.sendRequest('/bundles', 'getBundleStatuses', [params]);
      return response as unknown as BundleStatusResponse;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async getTransactionStatus(connection: Connection, signature: string) {
    try {
      // 180 second timeout
      let attempts = 0;
      const maxAttempts = 10; // 10 attempts
      const interval = 3000; // check every 3 seconds

      while (attempts < maxAttempts) {
        const signatureStatuses = await connection.getSignatureStatuses([signature]);
        const status = signatureStatuses.value[0];
        if (status) {
          if (!status.err) {
            console.log('Transaction succeeded');
            return {
              confirmation_status: BundleStatus.CONFIRMED,
              bundleId: signature,
            };
          } else {
            console.log('Transaction failed');
            return {
              confirmation_status: BundleStatus.FAILED,
              bundleId: signature,
            };
          }
        }

        await this.sleep(interval);
        attempts++;
      }

      // Timeout handling
    } catch (error) {
      console.log(error);
      return {
        confirmation_status: BundleStatus.TIMEOUT,
        bundleId: signature,
      };
    }
  }

  async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async confirmInflightBundle(bundleId: string, timeoutMs = 15000): Promise<any> {
    try {
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const detailedStatus = await this.getBundleStatuses([bundleId]);
        console.log('detailedStatus', detailedStatus);
        const result = detailedStatus;
        if (result && result.result && result.result.value && result.result.value.length > 0) {
          if (result.result.value[0]) {
            return result.result.value[0];
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // If we've reached this point, the bundle hasn't reached a final state within the timeout
      console.log(`Bundle ${bundleId} has not reached a final state within ${timeoutMs}ms`);
      return { status: 'Timeout', confirmation_status: BundleStatus.SENT, bundleId };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  isBundleSuccess(bundleStatus: any) {
    return (
      bundleStatus === BundleStatus.PROCESSED ||
      bundleStatus === BundleStatus.CONFIRMED ||
      bundleStatus === BundleStatus.FINALIZED
    );
  }

  getRandomTipAccount(): string {
    const randomIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNT.length);
    return JITO_TIP_ACCOUNT[randomIndex];
  }

  getTipInstruction(payer: PublicKey, priorityFee: number) {
    const randomTipAccount = this.getRandomTipAccount();
    const jitoTipAccount = new PublicKey(randomTipAccount);
    let tipAmount = priorityFee * LAMPORTS_PER_SOL;
    console.log('tipAmount', tipAmount);
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: jitoTipAccount,
      lamports: tipAmount,
    });
  }
}

export default JitoJsonRpcClient;
