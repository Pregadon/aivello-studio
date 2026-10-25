// Демо: Оля вмикає вбудований магазин, публікує його за $5, а посол Андрія купує рюкзак.
// Запуск: node demo/shop.ts
import { Embassy, FakePaymentGateway, HumanDevice, Switchboard, defaultMandate } from '../src/index.ts';
import type { ShopCommand } from '../src/index.ts';

const net = new Switchboard();
const pay = new FakePaymentGateway();
const oliaPhone = new HumanDevice('Оля');
const olia = new Embassy({
  id: 'olia',
  name: 'Оля',
  humanPublicKey: oliaPhone.publicKey,
  net,
  payments: pay,
  mandate: { ...defaultMandate(), deals: { level: 2, maxAmountUAH: 5000 } },
});
// Команда без поля embassy (розподіляємо Omit по варіантах об'єднання).
type Cmd = ShopCommand extends infer C ? (C extends ShopCommand ? Omit<C, 'embassy'> : never) : never;
const shop = (c: Cmd) => olia.manageShop(oliaPhone.sign({ embassy: 'olia', ...c } as ShopCommand));

console.log(`Магазин з коробки: ${olia.shop.status}`);
shop({ op: 'activate' });
console.log(`Після активації: ${olia.shop.status}. Бракує: ${olia.shop.missing().join(', ')}`);

shop({ op: 'profile', profile: { name: 'Олина майстерня', description: 'Сумки і рюкзаки зі шкіри', city: 'Львів' } });
shop({ op: 'add', product: { title: 'Шкіряний рюкзак', description: 'Ручна робота', priceUAH: 3200, minPriceUAH: 2900, stock: 2 } });

// Посол сам підготував ще один товар з фото, але додасть його лише після згоди Олі.
olia.draftProduct({ title: 'Гаманець', description: 'Шкіра, на 6 карток', priceUAH: 900, stock: 5 });
const [draft] = olia.proposals.values();
olia.decide(oliaPhone.sign({ embassy: 'olia', proposal: draft.id, approve: true }));

shop({ op: 'publish' });
console.log(`Опубліковано: ${olia.shop.status}. Списано: $${pay.charges[0].amountCents / 100}`);

const andriiPhone = new HumanDevice('Андрій');
const andrii = new Embassy({ id: 'andrii', name: 'Андрій', humanPublicKey: andriiPhone.publicKey, net });
net.ledger.credit('andrii', 10);

const [hit] = net.searchProducts('рюкзак');
console.log(`\nПосол Андрія знайшов: «${hit.product.title}» у магазині «${hit.shop}», ${hit.product.priceUAH} грн`);
andrii.startPurchase(
  andriiPhone.sign({ embassy: 'andrii', goal: { role: 'buyer', item: hit.product.title, targetUAH: 2700, limitUAH: 3100 } }),
  hit.embassy,
);
await net.flush();

for (const s of net.trace) {
  const m = s.payload;
  console.log(`  ${m.from.padEnd(7)} → ${m.type}${m.terms.priceUAH !== undefined ? ` ${m.terms.priceUAH} грн` : ''}`);
}
console.log('\n' + andrii.dispatch(new Date(0)).join('\n'));
console.log(`\nЗалишок рюкзаків у Олі: ${hit.product.stock}`);
