# warung-cart

Tiny cart math for a warung point-of-sale: subtotals, discounts and PPN (11% VAT), in whole Rupiah.

```js
import { total } from "./src/cart.mjs";
total([{ name: "Kopi tubruk", price: 10000, qty: 2 }], { discountPct: 10 }); // 19980
```

## Scripts

- `npm test` runs the tests with the Node test runner.

## Known issues

- #7 The subtotal ignores `qty`: two coffees cost the same as one.
