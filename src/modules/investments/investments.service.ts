import type { InvestmentTransaction, PrismaClient } from '@prisma/client';
import { Decimal } from '../../lib/money';

export interface Position {
  quantity: Decimal;
  avgPrice: Decimal; // preço médio de compra
  invested: Decimal; // custo das posições ainda em carteira (aprox. preço médio)
  income: Decimal; // proventos recebidos (dividendos + juros)
  marketValue: Decimal | null; // quantity * lastPrice (null se sem cotação)
}

/**
 * Posição DERIVADA dos movimentos (arquitetura §8). Preço médio por método de
 * custo médio: avg = custo total comprado / quantidade comprada.
 */
export function computePosition(
  txs: Pick<InvestmentTransaction, 'kind' | 'quantity' | 'unitPrice' | 'fees'>[],
  lastPrice: Decimal | null,
): Position {
  let qty = new Decimal(0);
  let boughtQty = new Decimal(0);
  let boughtCost = new Decimal(0);
  let income = new Decimal(0);

  for (const t of txs) {
    const quantity = new Decimal(t.quantity);
    const cost = quantity.times(t.unitPrice).plus(t.fees);
    switch (t.kind) {
      case 'BUY':
      case 'CONTRIBUTION':
        qty = qty.plus(quantity);
        boughtQty = boughtQty.plus(quantity);
        boughtCost = boughtCost.plus(cost);
        break;
      case 'SELL':
      case 'WITHDRAWAL':
        qty = qty.minus(quantity);
        break;
      case 'DIVIDEND':
      case 'INTEREST':
        income = income.plus(quantity.times(t.unitPrice));
        break;
    }
  }

  const avgPrice = boughtQty.gt(0) ? boughtCost.div(boughtQty) : new Decimal(0);
  const invested = qty.gt(0) ? qty.times(avgPrice) : new Decimal(0);
  const marketValue = lastPrice ? qty.times(lastPrice) : null;

  return { quantity: qty, avgPrice, invested, income, marketValue };
}

export async function assetWithPosition(db: PrismaClient, assetId: string) {
  const asset = await db.investmentAsset.findUnique({
    where: { id: assetId },
    include: { transactions: { where: { deletedAt: null }, orderBy: { date: 'asc' } } },
  });
  if (!asset) return null;
  const position = computePosition(asset.transactions, asset.lastPrice ? new Decimal(asset.lastPrice) : null);
  return { asset, position };
}
