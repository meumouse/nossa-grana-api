import { Prisma } from '@prisma/client';

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);

export function toDecimal(value: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function sum(values: Prisma.Decimal.Value[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(v), new Prisma.Decimal(0));
}

/**
 * Sinal da transação no saldo de uma conta: receita soma, despesa subtrai.
 * Transferência é tratada à parte (a perna sabe se entrou ou saiu via amount
 * assinado pelo serviço de transferência).
 */
export function signedForBalance(type: 'INCOME' | 'EXPENSE' | 'TRANSFER', amount: Prisma.Decimal): Prisma.Decimal {
  if (type === 'INCOME') return amount;
  if (type === 'EXPENSE') return amount.negated();
  return amount; // TRANSFER: o serviço já grava cada perna com o sinal correto via type
}
