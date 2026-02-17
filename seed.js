const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Define a chave PIX oficial
  await prisma.config.upsert({
    where: { key: 'CHAVE_PIX' },
    update: {},
    create: { key: 'CHAVE_PIX', value: 'CNPJ: 12.345.678/0001-99 (Pappi Pizza LTDA)' }
  });

  // Cadastra alguns sabores iniciais
  const saboresIniciais = [
    { nome: 'Margherita', preco: 45.0, ingredientes: 'Molho, mussarela, tomate e manjericão' },
    { nome: 'Calabresa', preco: 42.0, ingredientes: 'Molho, mussarela, calabresa e cebola' },
    { nome: 'Frango com Catupiry', preco: 48.0, ingredientes: 'Molho, mussarela, frango desfiado e catupiry' }
  ];

  for (const sabor of saboresIniciais) {
    await prisma.sabores.upsert({
      where: { nome: sabor.nome },
      update: { preco: sabor.preco, ingredientes: sabor.ingredientes },
      create: sabor
    });
  }

  console.log('✅ Banco da Pappi Pizza povoado com sucesso!');
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());
