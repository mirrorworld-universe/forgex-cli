/**
 * Wallet group management command group
 *
 * forgex wallet create-group | list-groups | group-info | delete-group |
 *                  generate | add | remove | import | export |
 *                  import-group | export-group | overview | grind
 */

import { Command } from 'commander';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import {
  getAllGroups,
  getGroup,
  saveGroup,
  removeGroup,
  addWalletsToGroup,
  removeWalletsFromGroup,
  generateWallets,
  walletFromPrivateKey,
  exportGroupToCsv,
  importWalletsFromCsv,
  exportAllGroupsJson,
  exportEncryptedGroupsJson,
  importGroupsFromJson,
  ensurePasswordAndValidate,
  getDecryptedPrivateKey,
} from '../../wallet-store.js';
import type { GroupInfo } from '../../wallet-store.js';
import { getDataSource } from '../../data-source.js';
import { VANITY_DIR, ensureConfigDir } from '../../config.js';
import { output, success, error, warn, getOutputFormat } from '../../output.js';

export function registerWalletCommands(program: Command): void {
  const walletCmd = program
    .command('wallet')
    .description('Wallet group management');

  // ============================================================
  // forgex wallet create-group
  // ============================================================
  walletCmd
    .command('create-group')
    .description('Create wallet group')
    .requiredOption('--name <name>', 'Wallet group name')
    .option('--type <type>', 'Type: local | monitor', 'local')
    .option('--remark <remark>', 'Remark', '')
    .option('--monitor-type <type>', 'Monitor type: normal | top100 | retail', 'normal')
    .option('--monitor-ca <ca>', 'Monitor token CA')
    .option('--filter-group-ids <ids>', 'Filter wallet group IDs (comma-separated)')
    .action(async (options) => {
      try {
        // Validate --type parameter
        if (options.type !== 'local' && options.type !== 'monitor') {
          error(`Invalid type "${options.type}", only local or monitor supported`);
          process.exit(1);
        }
        const groupType = options.type as 'local' | 'monitor';

        // Validate --monitor-type parameter
        const validMonitorTypes = ['normal', 'top100', 'retail'] as const;
        if (!validMonitorTypes.includes(options.monitorType)) {
          error(`Invalid monitor type "${options.monitorType}", only normal, top100 or retail supported`);
          process.exit(1);
        }
        const monitorType = options.monitorType as 'normal' | 'top100' | 'retail';

        const filterGroupIds = options.filterGroupIds
          ? options.filterGroupIds.split(',')
          : [];

        // Validate filterGroupIds values are valid numbers
        const filterGroupIdsNum = filterGroupIds.map(Number);
        if (filterGroupIdsNum.some(isNaN)) {
          error('--filter-group-ids contains invalid IDs, use comma-separated numbers');
          process.exit(1);
        }

        // Local-only: generate local group ID
        const existingGroups = getAllGroups();
        const maxId = existingGroups.reduce(
          (max, g) => Math.max(max, g.groupId), 0
        );
        const groupId = maxId + 1;

        // Local storage
        const newGroup: GroupInfo = {
          name: options.name,
          groupId,
          groupType,
          wallets: [],
          monitorType,
          note: options.remark,
          monitorCA: options.monitorCa,
          filterGroupIds: filterGroupIdsNum,
        };
        saveGroup(newGroup);

        output({
          success: true,
          groupId: newGroup.groupId,
          name: newGroup.name,
          type: newGroup.groupType,
        });
      } catch (e: any) {
        error('Failed to create wallet group', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet list-groups
  // ============================================================
  walletCmd
    .command('list-groups')
    .description('List all wallet groups')
    .option('--type <type>', 'Filter by type: local | monitor')
    .action((options) => {
      try {
        // Validate --type parameter
        if (options.type && options.type !== 'local' && options.type !== 'monitor') {
          error(`Invalid type "${options.type}", only local or monitor supported`);
          process.exit(1);
        }

        let groups = getAllGroups();
        if (options.type) {
          groups = groups.filter(g => g.groupType === options.type);
        }

        if (groups.length === 0) {
          const filterMsg = options.type ? `(type: ${options.type})` : '';
          warn(`No wallet groups found${filterMsg}`);
        }

        const result = groups.map(g => ({
          groupId: g.groupId,
          name: g.name,
          type: g.groupType,
          walletCount: g.wallets.length,
          monitorType: g.monitorType,
          note: g.note,
        }));

        output(result, {
          columns: [
            { key: 'groupId', header: 'ID' },
            { key: 'name', header: 'Name' },
            { key: 'type', header: 'Type' },
            { key: 'walletCount', header: 'Wallet Count' },
            { key: 'monitorType', header: 'Monitor Type' },
            { key: 'note', header: 'Note' },
          ],
        });
      } catch (e: any) {
        error('Failed to list wallet groups', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet group-info
  // ============================================================
  walletCmd
    .command('group-info')
    .description('View wallet group details')
    .requiredOption('--id <groupId>', 'Wallet group ID')
    .option('--show-keys', 'Show private keys (dangerous)', false)
    .action(async (options) => {
      try {
        const groupId = Number(options.id);
        if (isNaN(groupId)) {
          error(`Invalid wallet group ID "${options.id}", provide a numeric ID`);
          process.exit(1);
        }

        // If showing private keys, ensure password is set and correct first
        if (options.showKeys) {
          warn('Warning: About to display plaintext private keys. Ensure a secure environment. Never use this command in public or screen-sharing sessions');
          await ensurePasswordAndValidate();
        }

        const group = getGroup(groupId);
        if (!group) {
          error(`Wallet group ${groupId} does not exist`);
          process.exit(1);
        }

        const walletsList = group.wallets.map(w => {
          const entry: { address: string; note: string; privateKey?: string } = {
            address: w.walletAddress,
            note: w.note,
          };
          if (options.showKeys) {
            entry.privateKey = getDecryptedPrivateKey(w);
          }
          return entry;
        });

        const result = {
          groupId: group.groupId,
          name: group.name,
          type: group.groupType,
          walletCount: group.wallets.length,
          monitorType: group.monitorType,
          note: group.note,
          wallets: walletsList,
        };

        output(result);
      } catch (e: any) {
        error('Failed to get wallet group details', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet delete-group
  // ============================================================
  walletCmd
    .command('delete-group')
    .description('Delete wallet group')
    .requiredOption('--id <groupId>', 'Wallet group ID')
    .option('--force', 'Skip confirmation', false)
    .action(async (options) => {
      try {
        const groupId = Number(options.id);
        if (isNaN(groupId)) {
          error(`Invalid wallet group ID "${options.id}", provide a numeric ID`);
          process.exit(1);
        }

        // Check if wallet group exists locally
        const group = getGroup(groupId);
        if (!group) {
          error(`Wallet group ${groupId} does not exist`);
          process.exit(1);
        }

        // In non --force mode, prompt user for confirmation
        if (!options.force) {
          const { confirm } = await import('@inquirer/prompts');
          const confirmed = await confirm({
            message: `Confirm delete wallet group "${group.name}" (ID: ${groupId}, ${group.wallets.length} wallets)? This action is irreversible.`,
            default: false,
          });
          if (!confirmed) {
            warn('Delete operation cancelled');
            return;
          }
        }

        // Pure local deletion
        removeGroup(groupId);

        output({ success: true, groupId, message: 'Wallet group deleted' });
      } catch (e: any) {
        error('Failed to delete wallet group', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet generate
  // ============================================================
  walletCmd
    .command('generate')
    .description('Generate new wallets')
    .requiredOption('--group <groupId>', 'Target wallet group ID')
    .option('--count <n>', 'Count to generate', '1')
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();

        const groupId = Number(options.group);
        if (isNaN(groupId)) {
          error(`Invalid wallet group ID "${options.group}", provide a numeric ID`);
          process.exit(1);
        }

        const count = Number(options.count);
        if (isNaN(count) || !Number.isInteger(count) || count <= 0) {
          error(`Invalid count "${options.count}", provide a positive integer`);
          process.exit(1);
        }

        const group = getGroup(groupId);
        if (!group) {
          error(`Wallet group ${groupId} does not exist`);
          process.exit(1);
        }

        if (group.wallets.length + count > 100) {
          error(`Wallet count exceeded: currently ${group.wallets.length}, max ${100 - group.wallets.length} more (limit 100)`);
          process.exit(1);
        }

        const wallets = generateWallets(count);

        // Save plaintext private keys for output (addWalletsToGroup may encrypt privateKey in wallets)
        const plaintextKeys = wallets.map(w => ({
          address: w.walletAddress,
          privateKey: w.privateKey,
        }));

        // Pure local storage (if store is encrypted, this function encrypts privateKey fields)
        addWalletsToGroup(groupId, wallets);

        // Bug 1 fix: JSON keeps original structure; table/minimal use columns to display generated wallet list
        const fmt = getOutputFormat();
        if (fmt === 'json') {
          output({
            success: true,
            groupId,
            generated: plaintextKeys,
          });
        } else {
          success(`Generated ${plaintextKeys.length} wallets to group ${groupId}`);
          output(
            plaintextKeys.map((w, i) => ({
              index: i + 1,
              address: w.address,
              privateKey: w.privateKey,
            })),
            {
              columns: [
                { key: 'index', header: '#' },
                { key: 'address', header: 'Address' },
                { key: 'privateKey', header: 'Private Key' },
              ],
            }
          );
        }
      } catch (e: any) {
        error('Failed to generate wallets', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet add
  // ============================================================
  walletCmd
    .command('add')
    .description('Add wallet to group')
    .requiredOption('--group <groupId>', 'Target wallet group ID')
    .requiredOption('--private-key <key>', 'Private key (Base58 encoded)')
    .option('--note <note>', 'Note', '')
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();

        const groupId = Number(options.group);
        if (isNaN(groupId)) {
          error(`Invalid wallet group ID "${options.group}", provide a numeric ID`);
          process.exit(1);
        }

        // Verify wallet group exists
        const group = getGroup(groupId);
        if (!group) {
          error(`Wallet group ${groupId} does not exist`);
          process.exit(1);
        }

        // Validate private key validity
        let wallet;
        try {
          wallet = walletFromPrivateKey(options.privateKey, options.note);
        } catch {
          error('Invalid private key: provide a valid Base58 encoded private key');
          process.exit(1);
        }

        // Check if address already exists in group
        const exists = group.wallets.some(w => w.walletAddress === wallet.walletAddress);
        if (exists) {
          warn(`Wallet ${wallet.walletAddress} already exists in group ${groupId}, skipping duplicate`);
          output({
            success: true,
            groupId,
            address: wallet.walletAddress,
            duplicate: true,
          });
          return;
        }

        // Pure local storage
        addWalletsToGroup(groupId, [wallet]);

        output({
          success: true,
          groupId,
          address: wallet.walletAddress,
        });
      } catch (e: any) {
        error('Failed to add wallet', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet remove
  // ============================================================
  walletCmd
    .command('remove')
    .description('Remove wallet from group')
    .requiredOption('--group <groupId>', 'Target wallet group ID')
    .requiredOption('--address <addr>', 'Wallet address')
    .action(async (options) => {
      try {
        const groupId = Number(options.group);
        if (isNaN(groupId)) {
          error(`Invalid wallet group ID "${options.group}", provide a numeric ID`);
          process.exit(1);
        }

        // Verify wallet group exists
        const group = getGroup(groupId);
        if (!group) {
          error(`Wallet group ${groupId} does not exist`);
          process.exit(1);
        }

        // Verify address exists in wallet group
        const walletExists = group.wallets.some(w => w.walletAddress === options.address);
        if (!walletExists) {
          error(`Wallet ${options.address} is not in wallet group ${groupId}`);
          process.exit(1);
        }

        // Pure local removal
        removeWalletsFromGroup(groupId, [options.address]);

        output({
          success: true,
          groupId,
          removed: options.address,
        });
      } catch (e: any) {
        error('Failed to remove wallet', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet import
  // ============================================================
  walletCmd
    .command('import')
    .description('Import wallets from CSV file')
    .requiredOption('--group <groupId>', 'Target wallet group ID')
    .requiredOption('--file <csvPath>', 'CSV file path')
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();

        const groupId = Number(options.group);
        if (isNaN(groupId) || !Number.isInteger(groupId) || groupId <= 0) {
          error(`Invalid wallet group ID "${options.group}", provide a positive integer`);
          process.exit(1);
        }

        // Verify wallet group exists
        const group = getGroup(groupId);
        if (!group) {
          error(`Wallet group ${groupId} does not exist`);
          process.exit(1);
        }

        // Verify file exists
        if (!fs.existsSync(options.file)) {
          error(`CSV file does not exist: ${options.file}`);
          process.exit(1);
        }

        const csvContent = fs.readFileSync(options.file, 'utf-8');
        const wallets = importWalletsFromCsv(csvContent);

        if (wallets.length === 0) {
          error('No valid wallet data in CSV file');
          process.exit(1);
        }

        // Pure local storage
        addWalletsToGroup(groupId, wallets);

        output({
          success: true,
          groupId,
          imported: wallets.length,
          addresses: wallets.map(w => w.walletAddress),
        });
      } catch (e: any) {
        error('Failed to import wallets', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet export
  // ============================================================
  walletCmd
    .command('export')
    .description('Export wallet group as CSV file')
    .requiredOption('--group <groupId>', 'Wallet group ID')
    .requiredOption('--file <csvPath>', 'Output file path')
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();

        const groupId = Number(options.group);
        if (isNaN(groupId) || !Number.isInteger(groupId) || groupId <= 0) {
          error(`Invalid wallet group ID "${options.group}", provide a positive integer`);
          process.exit(1);
        }

        const csv = exportGroupToCsv(groupId);
        if (!csv) {
          error(`Wallet group ${groupId} does not exist`);
          process.exit(1);
        }

        fs.writeFileSync(options.file, csv, { encoding: 'utf-8', mode: 0o600 });
        output({
          success: true,
          groupId,
          file: options.file,
        });
      } catch (e: any) {
        error('Failed to export wallets', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet import-group
  // ============================================================
  walletCmd
    .command('import-group')
    .description('Import wallet groups from JSON file')
    .requiredOption('--file <jsonPath>', 'JSON file path')
    .option('--password <pwd>', 'Decryption password (required for encrypted files)')
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();

        // Verify file exists
        if (!fs.existsSync(options.file)) {
          error(`JSON file does not exist: ${options.file}`);
          process.exit(1);
        }

        const content = fs.readFileSync(options.file, 'utf-8');
        const groups = importGroupsFromJson(content, options.password);

        if (!groups || groups.length === 0) {
          error('No valid wallet group data in JSON file (if encrypted, check --password)');
          process.exit(1);
        }

        // Pure local storage (ensure private keys are encrypted via saveGroup + addWalletsToGroup)
        const existingGroups = getAllGroups();
        let nextLocalId = existingGroups.reduce(
          (max, g) => Math.max(max, g.groupId), 0
        ) + 1;

        groups.forEach((g) => {
          const newId = nextLocalId++;
          const wallets = g.wallets;
          g.groupId = newId;
          g.wallets = []; // Save empty wallet group first
          saveGroup(g);
          // Add wallets via addWalletsToGroup, which handles encryption automatically
          if (wallets.length > 0) {
            addWalletsToGroup(newId, wallets);
          }
        });

        output({
          success: true,
          imported: groups.length,
          groupIds: groups.map(g => g.groupId),
        });
      } catch (e: any) {
        error('Failed to import wallet groups', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet export-group
  // ============================================================
  walletCmd
    .command('export-group')
    .description('Export all wallet groups as JSON file')
    .requiredOption('--file <jsonPath>', 'Output file path')
    .option('--encrypt', 'Encrypted export', false)
    .option('--password <pwd>', 'Encryption password')
    .action(async (options) => {
      try {
        await ensurePasswordAndValidate();

        const groups = getAllGroups();
        if (groups.length === 0) {
          warn('No wallet groups to export');
          output({ success: true, file: options.file, encrypted: options.encrypt, groupCount: 0 });
          return;
        }

        let content: string;
        if (options.encrypt) {
          const password = options.password || process.env.FORGEX_PASSWORD;
          if (!password) {
            error('Encrypted export requires password, use --password or set FORGEX_PASSWORD env var');
            process.exit(1);
          }
          content = exportEncryptedGroupsJson(password);
        } else {
          content = exportAllGroupsJson();
        }

        fs.writeFileSync(options.file, content, { encoding: 'utf-8', mode: 0o600 });
        output({
          success: true,
          file: options.file,
          encrypted: options.encrypt,
          groupCount: groups.length,
        });
      } catch (e: any) {
        error('Failed to export wallet groups', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet overview
  // ============================================================
  walletCmd
    .command('overview')
    .description('View wallet group overview')
    .requiredOption('--groups <ids>', 'Wallet group IDs (comma-separated)')
    .option('--token <ca>', 'Filter by token')
    .action(async (options) => {
      try {
        const groupIds = options.groups.split(',').map(Number);

        // Validate all groupIds are valid positive integers
        if (groupIds.some(id => isNaN(id) || !Number.isInteger(id) || id <= 0)) {
          error(`Invalid wallet group ID list "${options.groups}", provide comma-separated positive integers`);
          process.exit(1);
        }

        // Verify wallet groups exist locally
        const missingIds = groupIds.filter(id => !getGroup(id));
        if (missingIds.length > 0) {
          warn(`The following wallet groups do not exist locally: ${missingIds.join(', ')}`);
        }

        const ds = getDataSource();

        // Build overview from DataStore local data
        const overviewResults: any[] = [];

        for (const gid of groupIds) {
          const group = getGroup(gid);
          if (!group) continue;

          // Determine token list to query
          const tokenCAs = options.token ? [options.token] : ds.listTokens();

          let totalValueSol = 0;
          let totalRealizedPnl = 0;
          let totalUnrealizedPnl = 0;
          let totalCostSol = 0;
          let totalTokenPositions = 0;

          for (const ca of tokenCAs) {
            const holdings = ds.getHoldings(ca, gid);
            if (!holdings || holdings.wallets.length === 0) continue;

            // Try to get token price
            let priceSol = 0;
            try {
              const priceData = await ds.getTokenPrice(ca);
              priceSol = priceData.priceSol;
            } catch {
              // Price unavailable, skip value calculation
            }

            for (const w of holdings.wallets) {
              const positionValue = w.tokenBalance * priceSol;
              totalValueSol += positionValue;
              totalRealizedPnl += w.realizedPnl;
              totalUnrealizedPnl += positionValue - w.tokenBalance * w.avgBuyPrice;
              totalCostSol += w.totalCostSol;
              if (w.tokenBalance > 0) totalTokenPositions++;
            }
          }

          const avgCost = totalTokenPositions > 0 ? totalCostSol / totalTokenPositions : 0;

          overviewResults.push({
            groupId: gid,
            groupName: group.name,
            totalValue: totalValueSol.toFixed(4),
            pnl: (totalRealizedPnl + totalUnrealizedPnl).toFixed(4),
            donePnl: totalRealizedPnl.toFixed(4),
            unDonePnl: totalUnrealizedPnl.toFixed(4),
            avgCost: avgCost.toFixed(6),
          });
        }

        if (overviewResults.length === 0) {
          warn('No wallet group overview data');
        }

        output(overviewResults, {
          columns: [
            { key: 'groupId', header: 'ID' },
            { key: 'groupName', header: 'Name' },
            { key: 'totalValue', header: 'Total Value(SOL)' },
            { key: 'pnl', header: 'Total P&L(SOL)' },
            { key: 'donePnl', header: 'Realized' },
            { key: 'unDonePnl', header: 'Unrealized' },
            { key: 'avgCost', header: 'Avg Cost' },
          ],
        });
      } catch (e: any) {
        error('Failed to get wallet group overview', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet grind
  // ============================================================
  walletCmd
    .command('grind')
    .description('Generate vanity address (custom suffix/prefix)')
    .requiredOption('--suffix <suffix>', 'Address suffix (e.g. pump)')
    .option('--prefix <prefix>', 'Address prefix')
    .option('--count <n>', 'Count to generate', '1')
    .option('--threads <n>', 'Grind thread count')
    .action(async (options) => {
      try {
        // Check if solana-keygen is available
        try {
          execSync('solana-keygen --version', { stdio: 'ignore' });
        } catch {
          error(
            'solana-keygen not found, please install Solana CLI toolchain first',
            'Install: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" or visit https://docs.solanalabs.com/cli/install'
          );
          process.exit(1);
        }

        const count = Number(options.count);
        if (isNaN(count) || !Number.isInteger(count) || count <= 0) {
          error(`Invalid count "${options.count}", provide a positive integer`);
          process.exit(1);
        }

        const suffix = options.suffix.trim();
        if (!suffix) {
          error('--suffix cannot be empty');
          process.exit(1);
        }

        // Verify suffix contains only Base58 characters
        const base58Chars = /^[1-9A-HJ-NP-Za-km-z]+$/;
        if (!base58Chars.test(suffix)) {
          error(`Invalid suffix "${suffix}", only Base58 characters supported (no 0, O, I, l)`);
          process.exit(1);
        }

        if (options.prefix && !base58Chars.test(options.prefix)) {
          error(`Invalid prefix "${options.prefix}", only Base58 characters supported (no 0, O, I, l)`);
          process.exit(1);
        }

        ensureConfigDir();

        // Build solana-keygen grind arguments
        const args: string[] = ['grind'];

        if (options.prefix) {
          args.push('--starts-and-ends-with', `${options.prefix}:${suffix}`);
        } else {
          args.push('--ends-with', `${suffix}:${count}`);
        }

        if (options.threads) {
          const threads = Number(options.threads);
          if (isNaN(threads) || !Number.isInteger(threads) || threads <= 0) {
            error(`Invalid thread count "${options.threads}", provide a positive integer`);
            process.exit(1);
          }
          args.push('--num-threads', String(threads));
        }

        const fmt = getOutputFormat();
        if (fmt !== 'json') {
          success(`Generating ${count} vanity addresses ending with "${suffix}", please wait...`);
          if (suffix.length >= 5) {
            warn('Long suffix, generation may take minutes or longer');
          }
        }

        // Execute grind in VANITY_DIR, generated .json files will be in that directory
        const child = spawn('solana-keygen', args, {
          cwd: VANITY_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        const exitCode = await new Promise<number | null>((resolve) => {
          child.on('close', resolve);
        });

        if (exitCode !== 0) {
          error('solana-keygen grind execution failed', stderr || stdout);
          process.exit(1);
        }

        // Parse generation results, solana-keygen output format: "Wrote keypair to <address>.json"
        const generatedFiles: Array<{ address: string; path: string }> = [];
        const lines = stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/Wrote keypair to (.+\.json)/);
          if (match) {
            const filename = match[1].trim();
            const filePath = path.resolve(VANITY_DIR, filename);
            const address = path.basename(filename, '.json');
            generatedFiles.push({ address, path: filePath });
          }
        }

        // In --starts-and-ends-with mode, need to manually control count
        if (options.prefix && generatedFiles.length > count) {
          generatedFiles.splice(count);
        }

        if (generatedFiles.length === 0) {
          warn('Unable to parse generated key files');
          process.exit(1);
        }

        if (fmt === 'json') {
          output({
            success: true,
            count: generatedFiles.length,
            suffix,
            prefix: options.prefix || null,
            dir: VANITY_DIR,
            keypairs: generatedFiles,
          });
        } else {
          success(`Successfully generated ${generatedFiles.length} vanity addresses, saved to ${VANITY_DIR}`);
          output(
            generatedFiles.map((f, i) => ({
              index: i + 1,
              address: f.address,
              path: f.path,
            })),
            {
              columns: [
                { key: 'index', header: '#' },
                { key: 'address', header: 'Address' },
                { key: 'path', header: 'File Path' },
              ],
            }
          );
        }
      } catch (e: any) {
        error('Failed to generate vanity addresses', e.message);
        process.exit(1);
      }
    });

  // ============================================================
  // forgex wallet grind-list
  // ============================================================
  walletCmd
    .command('grind-list')
    .description('List generated vanity addresses')
    .option('--suffix <suffix>', 'Filter by suffix')
    .action((options) => {
      try {
        ensureConfigDir();

        if (!fs.existsSync(VANITY_DIR)) {
          warn('No vanity addresses yet, run forgex wallet grind first');
          output([]);
          return;
        }

        const files = fs.readdirSync(VANITY_DIR).filter(f => f.endsWith('.json'));

        if (files.length === 0) {
          warn('No vanity addresses yet, run forgex wallet grind first');
          output([]);
          return;
        }

        let results = files.map(f => {
          const address = path.basename(f, '.json');
          const filePath = path.join(VANITY_DIR, f);
          const stat = fs.statSync(filePath);
          return {
            address,
            path: filePath,
            createdAt: stat.birthtime.toISOString().replace('T', ' ').slice(0, 19),
          };
        });

        if (options.suffix) {
          const suffixLower = options.suffix.toLowerCase();
          results = results.filter(r =>
            r.address.toLowerCase().endsWith(suffixLower)
          );
        }

        if (results.length === 0) {
          const filterMsg = options.suffix ? `(suffix: ${options.suffix})` : '';
          warn(`No matching vanity addresses found${filterMsg}`);
        }

        output(results, {
          columns: [
            { key: 'address', header: 'Address' },
            { key: 'createdAt', header: 'Created At' },
            { key: 'path', header: 'File Path' },
          ],
        });
      } catch (e: any) {
        error('Failed to list vanity addresses', e.message);
        process.exit(1);
      }
    });
}
