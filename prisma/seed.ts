import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Instituições financeiras brasileiras (catálogo global: workspaceId = null). */
const INSTITUTIONS: Array<{ name: string; shortName: string; brandColor: string }> = [
  { name: 'Nubank', shortName: 'Nubank', brandColor: '#820ad1' },
  { name: 'Itaú Unibanco', shortName: 'Itaú', brandColor: '#ec7000' },
  { name: 'Banco do Brasil', shortName: 'BB', brandColor: '#f9dd16' },
  { name: 'Bradesco', shortName: 'Bradesco', brandColor: '#cc092f' },
  { name: 'Caixa Econômica Federal', shortName: 'Caixa', brandColor: '#0070af' },
  { name: 'Santander', shortName: 'Santander', brandColor: '#ec0000' },
  { name: 'Banco Inter', shortName: 'Inter', brandColor: '#ff7a00' },
  { name: 'C6 Bank', shortName: 'C6', brandColor: '#242424' },
  { name: 'BTG Pactual', shortName: 'BTG', brandColor: '#001e62' },
  { name: 'Banco Original', shortName: 'Original', brandColor: '#00a868' },
  { name: 'Sicoob', shortName: 'Sicoob', brandColor: '#003641' },
  { name: 'Sicredi', shortName: 'Sicredi', brandColor: '#3a9b35' },
  { name: 'Banrisul', shortName: 'Banrisul', brandColor: '#0033a0' },
  { name: 'PicPay', shortName: 'PicPay', brandColor: '#21c25e' },
  { name: 'Mercado Pago', shortName: 'Mercado Pago', brandColor: '#009ee3' },
  { name: 'PagBank', shortName: 'PagBank', brandColor: '#0a8a3e' },
  { name: 'Banco Safra', shortName: 'Safra', brandColor: '#0b1f3a' },
  { name: 'Banco BMG', shortName: 'BMG', brandColor: '#f47920' },
  { name: 'Neon', shortName: 'Neon', brandColor: '#00d4ff' },
  { name: 'XP Investimentos', shortName: 'XP', brandColor: '#0a0a0a' },
  { name: 'Rico', shortName: 'Rico', brandColor: '#ff4d00' },
  { name: 'Binance', shortName: 'Binance', brandColor: '#f0b90b' },
  { name: 'Outra', shortName: 'Outra', brandColor: '#64748b' },
];

async function main(): Promise<void> {
  console.log('🌱 Semeando instituições globais...');
  let created = 0;

  for (const inst of INSTITUTIONS) {
    const exists = await prisma.institution.findFirst({
      where: { name: inst.name, workspaceId: null },
      select: { id: true },
    });
    if (!exists) {
      await prisma.institution.create({ data: { ...inst, workspaceId: null } });
      created += 1;
    }
  }

  console.log(`✔ Instituições: ${created} criadas, ${INSTITUTIONS.length - created} já existiam.`);
  console.log('ℹ As categorias padrão são criadas por workspace no cadastro/registro.');
}

main()
  .catch((err) => {
    console.error('✗ Falha no seed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
