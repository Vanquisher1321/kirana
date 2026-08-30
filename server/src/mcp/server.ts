import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  toolGetMerchantInfo, toolSearchProducts, toolGetProduct,
  toolCreateQuote, toolGetQuote, type ToolContext,
} from './tools.ts';
import type { Merchant } from '../types.ts';

/**
 * Builds the MCP server a buyer agent talks to. One per merchant.
 *
 * The tool descriptions below are part of the product, not decoration. A buyer
 * agent has no other documentation -- these strings are the entire contract it
 * reads before spending someone's money, so they state the constraints
 * (signed prices, expiry, who may raise a cap) rather than just naming fields.
 */

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function buildMcpServer(merchant: Merchant, agentId: string | null): McpServer {
  const ctx: ToolContext = { merchantId: merchant.id, agentId };

  const server = new McpServer(
    { name: `kirana-${merchant.slug}`, version: '0.1.0' },
    {
      instructions:
        `You are connected to the storefront "${merchant.name}" (${merchant.originUrl}) through Kirana, ` +
        `which makes ordinary merchants transactable by AI buyers.\n\n` +
        `Prices are quoted in ${merchant.currency} and are exact. Always create a quote before ` +
        `attempting payment: a quote is cryptographically signed, expires in 10 minutes, and fixes the ` +
        `price. You cannot alter a quoted total, and you cannot pay above the spending cap the human ` +
        `approved. If a price or stock level changes between quote and payment, the payment will be ` +
        `refused rather than charged at the new price — request a fresh quote and tell the human what moved.`,
    },
  );

  server.registerTool(
    'get_merchant_info',
    {
      title: 'Merchant details',
      description:
        'Shop name, currency, delivery rules, catalog size and how the catalog was obtained. ' +
        'Call this first to understand what you are shopping.',
      inputSchema: {},
    },
    async () => ok(toolGetMerchantInfo(ctx)),
  );

  server.registerTool(
    'search_products',
    {
      title: 'Search the catalog',
      description:
        'Keyword search across product titles, descriptions, tags and vendor, with optional rupee price ' +
        'filters. Prices are plain rupee numbers (1500 means ₹1,500.00). Returns exact prices in paise ' +
        'alongside formatted strings — quote the formatted string to the human.',
      inputSchema: {
        query: z.string().optional().describe('Free-text search, e.g. "medium roast coffee"'),
        max_price_inr: z.union([z.number(), z.string()]).optional().describe('Only items at or below this rupee amount'),
        min_price_inr: z.union([z.number(), z.string()]).optional(),
        in_stock_only: z.boolean().optional().describe('Exclude items that cannot currently be bought'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => ok(toolSearchProducts(ctx, args as never)),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Product detail',
      description: 'Full detail for one product, including every purchasable variant and its variant_id.',
      inputSchema: { product_id: z.string() },
    },
    async (args) => ok(toolGetProduct(ctx, args as never)),
  );

  server.registerTool(
    'create_quote',
    {
      title: 'Quote a basket',
      description:
        'Price a basket of variants. Returns a signed quote_id with a fixed total and a 10-minute expiry. ' +
        'Out-of-stock items are refused here rather than at payment. This does NOT charge anything.',
      inputSchema: {
        items: z.array(z.object({
          variant_id: z.string(),
          quantity: z.number().int().min(1).max(100),
        })).min(1).max(50),
      },
    },
    async (args) => ok(toolCreateQuote(ctx, args as never)),
  );

  server.registerTool(
    'get_quote',
    {
      title: 'Re-read a quote',
      description: 'Current status and totals for a quote you already created.',
      inputSchema: { quote_id: z.string() },
    },
    async (args) => ok(toolGetQuote(ctx, args as never)),
  );

  return server;
}
