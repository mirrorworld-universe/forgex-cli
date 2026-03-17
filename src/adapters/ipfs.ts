/**
 * IPFS Upload Adapter
 *
 * Directly uploads token metadata to pump.fun/api/ipfs.
 */

import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';

/**
 * Upload token metadata to IPFS (direct to pump.fun/api/ipfs)
 */
export const uploadToIpfs = async (filePath: string, metadata?: {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}) => {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));
  if (metadata) {
    formData.append('name', metadata.name);
    formData.append('symbol', metadata.symbol);
    formData.append('description', metadata.description);
    formData.append('twitter', metadata.twitter || '');
    formData.append('telegram', metadata.telegram || '');
    formData.append('website', metadata.website || '');
    formData.append('showName', 'true');
  }

  const response = await axios.post('https://pump.fun/api/ipfs', formData, {
    headers: formData.getHeaders(),
    timeout: 30000,
  });
  return response.data;
};
